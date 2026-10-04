import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AirPrompterAgent, publicJwkOf, releaseDigest, type Experiment, type LoadedRelease } from "@airprompter/agent-sdk";
import { FakeControlPlane } from "@airprompter/agent-sdk/testing";
import { compareRun, previewAssignments, publishedReader, publishedRollout } from "../src/integration.js";
import type { RunRecord } from "../src/run.js";

function fixture(experiment = false) {
  const plane = new FakeControlPlane({ organizationId:"org_fixture",agentId:"agent_fixture",target:"dev" });
  const a=plane.slot({tag:"support.reply",text:"{{ticket}}",versionId:"rev-a",model:"fixture-model",variables:[{name:"ticket",required:true,trust:"end_user"}],inference:{temperatureMilli:300,maxOutputTokens:600}});
  const b=plane.slot({tag:"support.reply",text:"{{ticket}}",versionId:"rev-b",model:"fixture-model",variables:a.variables,inference:{maxOutputTokens:900,temperatureMilli:500}});
  const split: Experiment={experimentId:"exp_fixture",tag:"support.reply",salt:"EBESExQVFhcYGRobHB0eHw",subjectKey:"request",arms:[{arm:"control",weightBps:9000,releaseDigest:releaseDigest([a]),overrides:[]},{arm:"candidate",weightBps:1000,releaseDigest:releaseDigest([b]),overrides:[b]}]};
  const manifest=plane.promote([a],experiment ? {experiments:[split]} : {});
  const release: LoadedRelease={manifest,generation:manifest.payload.generation,payloads:plane.payloads};
  return {plane,release};
}

test("origin read verifies the signed release independently, survives unchanged reads and rejects bad signatures", async () => {
  const {plane}=fixture();
  const config={baseUrl:"https://api.test",organizationId:plane.scope.organizationId,agentId:plane.scope.agentId,environment:"dev",hostedEnvironment:"dev",rootUrl:"https://edge.test/roots/dev/root.json",rootJwk:JSON.stringify(publicJwkOf(plane.rootKey))};
  const read=publishedReader(config,plane.apiKey,plane.fetch() as never);
  assert.equal((await read()).generation,1);
  assert.equal((await read()).generation,1);
  assert.equal(plane.heartbeats.length,0,"independent reads create no runtime or telemetry");
  plane.promote([plane.slot({tag:"support.reply",text:"{{ticket}}",versionId:"rev-next"})]);
  assert.equal((await read()).generation,2);
  plane.promote([plane.slot({tag:"support.reply",text:"{{ticket}}",versionId:"rev-bad"})], { signWith: fixture().plane.signingKey });
  await assert.rejects(read(),/published_release_refused/);
});

test("illustration uses repeatable SDK buckets; changing the preview dial never changes the release", () => {
  const {release}=fixture();
  const before=JSON.stringify(release.manifest);
  const preview=previewAssignments(release,50,Date.now());
  assert.ok(!('error' in preview));
  if ('error' in preview) return;
  assert.equal(preview.mode,'illustration');
  assert.equal(preview.rows.length,100);
  assert.deepEqual(preview.rows, (previewAssignments(release,50,Date.now()) as typeof preview).rows);
  assert.equal((previewAssignments(release,0,Date.now()) as typeof preview).counts.control,100);
  assert.equal((previewAssignments(release,100,Date.now()) as typeof preview).counts.candidate,100);
  assert.equal(JSON.stringify(release.manifest),before);
  const published=previewAssignments(release,null,Date.now()) as typeof preview;
  assert.equal(published.mode,'published');
  assert.equal(published.counts.none,100);
  assert.deepEqual(previewAssignments(release,-1,Date.now()),{error:'invalid_percentage'});
});

test("live preview uses the signed experiment and what-if assignments retain customer buckets", () => {
  const {release}=fixture(true);
  const live=previewAssignments(release,null,Date.now());
  assert.ok(!('error' in live));
  if ('error' in live) return;
  assert.equal(live.experimentId,'exp_fixture');
  assert.deepEqual(live.weights,[{arm:'control',weightBps:9000},{arm:'candidate',weightBps:1000}]);
  const dial=previewAssignments(release,50,Date.now()) as typeof live;
  for (const row of live.rows.filter(r=>r.arm==='candidate')) assert.equal(dial.rows.find(r=>r.visitor===row.visitor)?.arm,'candidate');
});

test("comparison reports metadata differences and refuses missing recorded variables without guessing", () => {
  const {release}=fixture();
  const saved={runId:'run_fixture',customerId:'customer_fixture',steps:[{step:'reply',tag:'support.reply',versionId:'rev-old',generation:0,arm:'none',model:'fixture-model',rendered:{text:'fixture',variables:[],inference:{maxOutputTokens:600,temperatureMilli:300}}}]} as unknown as RunRecord;
  const comparison=compareRun(saved,release,Date.now());
  assert.equal(comparison.steps[0]?.matches?.version,false);
  assert.equal(comparison.steps[0]?.matches?.settings,true,"setting order is immaterial");
  assert.equal(comparison.steps[0]?.matches?.prompt,null);
  assert.equal(comparison.steps[0]?.reason,'saved_variables_insufficient');
  assert.ok(!JSON.stringify(comparison).includes('runRef'));
});


test("instance assignment refuses visitor what-if and comparison without original instance evidence", () => {
  const {release}=fixture(true);
  release.manifest.payload.experiments![0]!.subjectKey="instance";
  assert.deepEqual(previewAssignments(release,50,Date.now()),{error:'preview_requires_request_assignment'});
  const saved={runId:'run_fixture',customerId:'customer_fixture',steps:[{step:'reply',tag:'support.reply'}]} as unknown as RunRecord;
  assert.equal(compareRun(saved,release,Date.now()).steps[0]?.reason,'original_instance_not_recorded');
});

test("published metadata walks the signed schedule without rewriting a release", () => {
  const {release}=fixture(true);
  const now=Date.now();
  release.manifest.payload.experiments![0]!.ramp=[{notBefore:new Date(now+3_600_000).toISOString(),weightBps:[5000,5000]},{notBefore:new Date(now+7_200_000).toISOString(),weightBps:[0,10000]}];
  const before=JSON.stringify(release);
  const first=publishedRollout(release,now);
  assert.deepEqual(first.weights.map(w=>w.weightBps),[9000,1000]);
  assert.deepEqual(publishedRollout(release,now+3_600_000).weights.map(w=>w.weightBps),[5000,5000]);
  assert.deepEqual(publishedRollout(release,now+7_200_000).weights.map(w=>w.weightBps),[0,10000]);
  assert.equal(JSON.stringify(release),before);
  assert.ok(!JSON.stringify(first).includes('salt'));
  assert.ok(!JSON.stringify(first).includes('contentHash'));
});

test("real SDK syncs a published release automatically and runs its cached scheduled percentage", async () => {
  const {plane}=fixture(true);
  const stateDir=mkdtempSync(join(tmpdir(),"zudocs-auto-"));
  let now=Date.now();
  const ap=await AirPrompterAgent.start({...plane.scope,apiKey:plane.apiKey,baseUrl:'https://api.test',stateDir,root:{pinned:publicJwkOf(plane.rootKey),hostedEnvironment:'dev'},sync:{mode:'resident',pollSeconds:3600,rootUrl:'https://edge.test/roots/dev/root.json'},apply:{policy:'auto'},fetch:plane.fetch(),telemetry:{sink:'memory',upload:false},now:()=>now});
  try {
    assert.equal(ap.generation,1);
    const release=fixture(true).release;
    const experiment=release.manifest.payload.experiments![0]!;
    const slot=plane.slot({tag:'support.reply',text:'{{ticket}}',versionId:'rev-next',variables:[{name:'ticket',required:true,trust:'end_user'}]});
    experiment.arms[1]!.overrides=[slot];
    experiment.arms[1]!.releaseDigest=releaseDigest([slot]);
    experiment.ramp=[{notBefore:new Date(now+3_600_000).toISOString(),weightBps:[5000,5000]},{notBefore:new Date(now+7_200_000).toISOString(),weightBps:[0,10000]}];
    plane.promote([slot],{applyPolicy:'auto',experiments:[experiment],leaseSeconds:10800});
    await ap.syncNow();
    assert.equal(ap.generation,2,JSON.stringify({reason:ap.status().lastRefusal,outcome:ap.status().lastSyncOutcome}));
    assert.equal(ap.status().stagedGeneration,null);
    const requests=plane.requests.length;
    now+=3_600_000;
    assert.deepEqual(ap.status().ramps[0]?.weightBps,[5000,5000]);
    now+=3_600_000;
    assert.deepEqual(ap.status().ramps[0]?.weightBps,[0,10000]);
    const rendered=ap.prompt('support.reply',{subject:'same-customer'}).render({ticket:'fixture'});
    assert.equal(rendered.arm,'candidate');
    assert.equal(rendered.versionId,'rev-next');
    assert.equal(plane.requests.length,requests,"cached schedule advances without another platform request");
    plane.promote([slot],{applyPolicy:'unlock_required',leaseSeconds:10800});
    await ap.syncNow();
    assert.equal(ap.generation,2,"automatic sync does not bypass signed policy tightening");
    assert.equal(ap.status().stagedGeneration,3);
    assert.equal(ap.status().applyPolicy.effective,'unlock_required');
  } finally {await ap.stop();rmSync(stateDir,{recursive:true,force:true});}
});
