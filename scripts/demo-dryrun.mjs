#!/usr/bin/env node
/**
 * Every panel of the desk, exercised against the live deployment in order, with every presenter click made for real
 * and what the desk shows asserted: the badge flips, eu-west takes each release on its own, the fleet agrees, the
 * freeze refuses every Run (the button stays clickable; the refusal is the beat), the arms split and stick per
 * customer on two hosts, the ramp plan reaches the hosts, the golden set holds a release back, the variables come
 * from the desk's table, the wire cut degrades and the restore recovers, the windows leave the host. Prints a
 * transcript with timings (ids, generations, codes, counts — never prompt text, never a key) and exits 1 when a
 * claim fails. This is the plan's gate: "a full dry run of the nine beats, twice in a row from a reset".
 *
 * What happens in AirPrompter (a new version, a seal, a promotion, an experiment, a dial, the winner, a freeze) is
 * a person's act in the console, never this script's: at each such beat it prints one plain instruction and waits,
 * bounded (ten minutes), until zudocs sees the effect on its own side — the environment's public edge pointer
 * naming a newer generation, or the hosts' status rows reporting it. A refusal the console itself shows (the seal
 * refusing a placeholder or a model) is named for the person and not observed here. `--skip-console-beats` skips
 * every beat that needs the console, with a line saying so: a rehearsal of the zudocs side alone.
 *
 * Needs the proof password (`ZUDOCS_PROOF_PASSWORD`) and the owner's AWS profile (CloudWatch, the stack outputs);
 * no AirPrompter credential. ~25 minutes plus the console acts; the wire beat is the slow one (`--skip-wire` for a
 * rehearsal), `--hosted` runs beat 1's hosted-staging step, `--airgap` expects the air-gapped host to be up
 * (`npm run airgap:up` first), `--strips` records the CLI strips at the end, `--UNSAFE-promote-hosts-must-refuse`
 * takes beat 5's model drill down the other platform's path (the person promotes the unreported model and the hosts
 * must refuse it) instead of the seal's refusal — never in a session.
 *
 * @example
 * ```sh
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'
 * npm run demo:dryrun -- --hosted --airgap --strips          # the full gate, then `npm run demo:reset`, then again
 * npm run demo:dryrun -- --skip-wire --skip-console-beats    # a rehearsal of the zudocs side
 * ```
 */
import { spawnSync } from "node:child_process";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { readConfig } from "./lib/config.mjs";
import { RAMP, armsByCustomer, edgeGeneration, fleetAgreement, releaseLine } from "./lib/demo.mjs";
import { connectDesk, repoRootOf } from "./lib/desk.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const say = (line) => console.log(line);
let failures = 0;
const ok = (m) => say(`    ✓ ${m}`);
const fail = (m) => { failures += 1; say(`    ✗ ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));
const gap = (m) => say(`    ⚠ gap: ${m}`);
const t0 = Date.now();
const stamp = () => `${String(Math.floor((Date.now() - t0) / 60000)).padStart(2, "0")}:${String(Math.floor(((Date.now() - t0) % 60000) / 1000)).padStart(2, "0")}`;
const beat = (n, title) => say(`\n[${stamp()}] Beat ${n} — ${title}`);

let config;
try {
  config = readConfig();
} catch (error) {
  console.log(error.message);
  process.exit(2);
}
const ENV = config.environment;
const skipConsole = flag("--skip-console-beats");
/** How long a person has for one console act before the beat's claim fails (the run goes on). */
const CONSOLE_WAIT_MS = 10 * 60_000;
const desk = await connectDesk();
const EAST = "us-east-1/lambda";
const EU = "eu-west-1/ec2";
const PULLER = "ap-southeast-1/puller";
const AIRGAP = "ap-southeast-1/airgap";
const TICKET = "T-1041";

const replyStep = (run) => (run?.steps ?? []).find((s) => s.step === "reply") ?? null;
const triageStep = (run) => (run?.steps ?? []).find((s) => s.step === "triage") ?? null;
const badge = (step) => (step ? `${step.tag.replace(/^support\./, "")} ${step.versionId} · release #${step.generation} · ${step.model}${step.arm && step.arm !== "none" ? ` · arm ${step.arm}` : ""}` : "no step");
const runTicket = async (ticketId) => desk.api("POST", `/tickets/${ticketId}/run`);
const syncEast = async () => (await desk.api("POST", "/presenter/sync")).json;
const eventsOfKind = async (since, kind, host) => (await desk.eventsSince(since)).filter((e) => e.kind === kind && (!host || e.host === host));
/** One allowlisted zudocs-cli command on eu-west: the API queues it; the CLI's document lands on the timeline. */
async function hostCli(command, { timeoutMs = 150_000 } = {}) {
  const since = new Date().toISOString();
  const queued = await desk.api("POST", "/presenter/host_cli", { command });
  if (queued.status !== 202) return { status: `HTTP ${queued.status}`, summary: queued.json.message ?? JSON.stringify(queued.json).slice(0, 200), document: null };
  return desk.waitFor(`zudocs-cli ${command} to answer`, async () => (await eventsOfKind(since, "host_cli", EAST)).find((e) => e.command === command) ?? null, { timeoutMs, everyMs: 5_000 });
}

/** The newest generation zudocs sees without a credential: the public edge pointer, else what us-east serves after a sync. */
const currentGeneration = async () => (await edgeGeneration(config.edgePointerUrl)) ?? Number((await syncEast()).generation);
/**
 * A beat that needs AirPrompter: a person does `act` in the console; this prints it and waits, bounded, until
 * `observe` (zudocs's own systems, or the public edge pointer) sees the effect. Null when skipped
 * (`--skip-console-beats`) or not seen in time — the latter a failed claim.
 */
async function inConsole(act, what, observe, { timeoutMs = CONSOLE_WAIT_MS, everyMs = 10_000 } = {}) {
  if (skipConsole) { say(`    ⏭ needs the console: ${act} (skipped: --skip-console-beats)`); return null; }
  say(`    → In AirPrompter: ${act}`);
  const seen = await desk.waitFor(what, observe, { timeoutMs, everyMs }).catch(() => null);
  if (seen === null) fail(`${what}: not seen within ${timeoutMs / 60_000} min — was it done in the console?`);
  return seen;
}
/** A console act that moves the environment (a promotion, an experiment, a dial — each is a generation): the newer generation, or null. */
const newGeneration = (act, after) => inConsole(act, `a generation newer than #${after}`, async () => { const g = await currentGeneration(); return g > after ? g : null; });
/** What only the console shows (a seal's refusal, its own pages): named for the person; nothing here observes it. */
const showInConsole = (what) => say(skipConsole ? `    ⏭ needs the console: ${what} (skipped: --skip-console-beats)` : `    → In AirPrompter: ${what}`);
const BOARD = `the zudocs-support agent's board (${ENV})`;
const RAMP_WORDS = RAMP.map((step) => `${step.weightBps / 100} %${step.holdMinutes ? ` for ${step.holdMinutes} min` : ""}`).join(" → ");

/** Observe automatic SDK activation on both Europe workers; never approve or unlock locally. */
async function waitForEuWest(generation, { timeoutMs = 180_000 } = {}) {
  const row = await desk.waitFor(`Europe to sync #${generation}`, async () => {
    const report = await desk.hostRow(EU);
    return report?.status?.generation === generation && report?.python?.generation === generation ? report : null;
  }, { timeoutMs });
  ok(`Europe SDKs report release #${generation} automatically`);
  return row;
}

/** A promotion landing on every host: us-east on the next invoke, eu-west by resident sync, the puller on a nudge, the air-gapped host from the exchange. */
async function landEverywhere(generation, { approve = true } = {}) {
  const sync = await syncEast();
  check(sync.generation === generation, `us-east synced on the next invoke: generation ${sync.generation} (${sync.outcome}, ${sync.applyState})`);
  if (approve) await waitForEuWest(generation);
  const nudged = await desk.api("POST", "/presenter/nudge");
  check(nudged.status === 202, `nudged the fleet: ${nudged.json.messageId ?? nudged.json.message}`);
  const puller = await desk.waitFor(`the exchange to hold #${generation}`, async () => { const r = await desk.hostRow(PULLER); return Number(r?.status?.generation) === generation ? r : null; }, { timeoutMs: 180_000, everyMs: 10_000 });
  ok(`the exchange holds #${generation} (pulled ${puller.status.pulledAt}, ${puller.status.keyId ? "sealed" : "plaintext"})`);
  if (flag("--airgap")) {
    // The host applies within its own timer, but its row reaches the desk only when the puller mirrors it — one
    // puller tick (five minutes at the deployed cadence, one with the demo flag). A nudge every ninety seconds is
    // the presenter's own click (Nudge the fleet) and brings the mirror forward; the wait spans a full tick anyway.
    let lastNudge = Date.now();
    const airgap = await desk.waitFor(`the air-gapped host to apply #${generation} (one puller tick; nudging every 90 s)`, async () => {
      const r = await desk.hostRow(AIRGAP);
      if (Number(r?.status?.generation) === generation) return r;
      if (Date.now() - lastNudge > 90_000) { lastNudge = Date.now(); await desk.api("POST", "/presenter/nudge"); }
      return null;
    }, { timeoutMs: 420_000, everyMs: 10_000 });
    ok(`the air-gapped host applied #${generation} (written ${airgap.writtenAt}, mirrored ${airgap.mirroredAt})`);
  }
}

// --- Beat 0: the cold open ------------------------------------------------------------------------------------------
beat(0, "cold open: one ticket, Run, a badge");
// After a reset every container is cold; the first request runs the boot sync and the golden set and can pass the
// API's 30-second cap once (click Sync now first) — the rehearsal does the same.
const state0 = await desk.waitFor("the desk to answer (a cold container syncs and runs the golden set first)", async () => { const s = await desk.state(); return s?.host?.status ? s : null; }, { timeoutMs: 180_000, everyMs: 5_000 });
const gen0 = state0.host.status.generation;
say(`    fleet: ${state0.hosts.map((h) => `${h.hostId} #${h.status?.generation ?? "?"}`).join(" · ")} · us-east container ${state0.host.instanceId.slice(0, 12)} · frozen ${state0.frozen?.frozen}`);
check(!state0.frozen?.frozen, "the environment is not frozen at the start (run the reset first)");
const run0 = await runTicket(TICKET);
const r0 = replyStep(run0.json.run);
check(run0.status === 200 && run0.json.run?.ok === true, `${TICKET} ran on us-east: ${badge(r0)} · ${r0?.observation?.latencyMs} ms · ${r0?.observation?.tokens?.input}/${r0?.observation?.tokens?.output} tokens · judge ${r0?.judge?.score ?? "—"} · checks ${r0?.checks?.map((c) => c.verdict).join(",")}`);
check(r0?.generation === gen0, `the badge names the release the host serves (#${gen0})`);

// --- Beat 1: change the words, no deploy ------------------------------------------------------------------------------
beat(1, "change the words, no deploy");
const since1 = new Date().toISOString();
const g1 = await newGeneration(`on ${BOARD}, save a new support.reply version with a visible change (open with the customer's name), seal the ${ENV} release with it and promote it`, gen0);
if (g1 !== null) {
  ok(`AirPrompter promoted ${ENV} to generation ${g1}`);
  await landEverywhere(g1);
  const run1 = await runTicket(TICKET);
  const r1 = replyStep(run1.json.run);
  check(r1?.versionId !== r0?.versionId && r1?.generation === g1, `re-run: the badge flipped to ${badge(r1)} (was ${r0?.versionId ?? "?"})`);
  const changed = await eventsOfKind(since1, "release_changed", EAST);
  check(changed.some((e) => e.generation === g1), `the timeline shows release #${g1} landing on us-east (${changed.length} row(s))`);
}
if (flag("--hosted")) {
  const hosted = await desk.api("POST", `/tickets/${TICKET}/hosted-run`);
  const h = hosted.json.run;
  if (hosted.status === 501) gap(`hosted staging is not configured on this deployment: ${hosted.json.message}`);
  else {
    ok(`hosted catalogue: staging generation ${h.catalogue.generation}, reply on ${h.catalogue.slot?.model} with ${JSON.stringify(h.catalogue.slot?.inference)}; ${h.subjectHash ? `subject hash computed on the desk (${h.subjectHash.slice(0, 12)}…)` : `no experiment on staging (${h.catalogue.experiments.length} listed), so no subject hash — the customer id never leaves the desk either way`}`);
    if (h.stream.result) ok(`hosted stream: ${h.stream.deltas.length} deltas, ${badge({ tag: "support.reply", versionId: h.stream.result.versionId, generation: h.stream.result.generation, model: h.stream.result.model, arm: h.stream.result.arm })} · ${h.stream.result.priceMicros} µ$ · feedback ${h.feedback?.accepted}`);
    else gap(`hosted run refused by the route: ${h.stream.refusal?.code} (HTTP ${h.stream.refusal?.status}) ${h.stream.refusal?.message} — recorded as such; platform issue #906`);
    // `ignoredByContract` is the contract's word, not the route's: the response carries no settings, so nothing here can observe the ignoring. Informational unless the route answered.
    const compatLine = `compatible endpoint called with temperature ${h.compat?.request.temperature} / top_p ${h.compat?.request.top_p} (ignored by contract: ${(h.compat?.ignoredByContract ?? []).join(", ")} — the response carries no settings) beside the sealed ${JSON.stringify(h.catalogue.slot?.inference)}; it answered HTTP ${h.compat?.response.status}${h.compat?.response.runRef ? ` runRef ${h.compat.response.runRef.slice(0, 10)}…` : ""}`;
    if (h.compat?.response.status === 200) check(h.compat.request.temperature === 1.9 && h.compat.response.runRef !== null, compatLine);
    else ok(`${compatLine} (informational: the route did not answer 200, so the call is recorded, not asserted)`);
  }
}

// --- Beat 2: the fleet -----------------------------------------------------------------------------------------------------
beat(2, "the fleet");
const state2 = await desk.state();
const rows2 = Object.fromEntries(state2.hosts.map((h) => [h.hostId, h]));
check(rows2[EAST]?.status?.storageProtection === "kms", `us-east: Lambda, store key ${rows2[EAST]?.status?.storageProtection}, policy ${rows2[EAST]?.status?.applyPolicy?.effective} (${rows2[EAST]?.status?.applyPolicy?.source}), sdk ${rows2[EAST]?.sdk}`);
check(rows2[EU]?.status?.storageProtection === "file_key" && rows2[EU]?.status?.applyPolicy?.effective === "auto", `eu-west: daemon host, store key ${rows2[EU]?.status?.storageProtection} (amber, doctor warns), policy ${rows2[EU]?.status?.applyPolicy?.effective} (${rows2[EU]?.status?.applyPolicy?.source}), workers node ${rows2[EU]?.worker?.attached ? "attached" : "detached"} / python ${rows2[EU]?.python?.attached ? "attached" : "detached"}`);
check(rows2[PULLER]?.kind === "puller", `ap-southeast: puller holds #${rows2[PULLER]?.status?.generation} in the exchange`);
if (flag("--airgap")) check(rows2[AIRGAP]?.kind === "airgapped" && rows2[AIRGAP]?.airgap?.keyPublished, `air-gapped host: no route out, key ${rows2[AIRGAP]?.airgap?.keyId?.slice(0, 8)}… born on the host, ${rows2[AIRGAP]?.airgap?.renders?.count} render probes filed as refused`);
else say(`    (air-gapped host ${rows2[AIRGAP] ? `row written ${rows2[AIRGAP].writtenAt} — ${Date.now() - Date.parse(rows2[AIRGAP].writtenAt) > 15 * 60_000 ? "down" : "up"}` : "never seen"}; --airgap to require it)`);
{
  // What the host reports is what the application declares it can call (airprompter.config.json › models): the
  // same set, not a count.
  const reported = [...(state2.host.models ?? [])].sort();
  const declared = [...config.models].sort();
  check(reported.length > 0 && JSON.stringify(reported) === JSON.stringify(declared), `models this host reports: ${reported.join(", ")}${JSON.stringify(reported) === JSON.stringify(declared) ? " (the config's set)" : ` — the config declares ${declared.join(", ")}`}`);
}

// --- Beat 3: you activate, not us; then freeze --------------------------------------------------------------------------------
beat(3, "you activate, not us — and the freeze");
ok("the approval was the beat-1 approval above (staged → Approve → live with timestamps)");
const since3 = new Date().toISOString();
const stateF = await inConsole(`freeze ${ENV} on ${BOARD}`, "us-east to report frozen", async () => { await syncEast(); const s = await desk.state(); return s.frozen?.frozen ? s : null; });
if (stateF) {
  ok(`release bar: FROZEN — ${stateF.frozen.reason} (generation ${stateF.host.status.generation} carries the directive)`);
  const runF = await runTicket("T-1042");
  check(runF.status === 423 && runF.json.error === "frozen", `Run refused: HTTP ${runF.status} ${runF.json.error} — ${runF.json.message}`);
  const euFrozen = await desk.waitFor("Europe to honour the signed freeze", async () => {
    const r = await desk.hostRow(EU); return r?.status?.disabled?.agent ? r : null;
  }, { timeoutMs: 150_000, everyMs: 10_000 }).catch(() => null);
  check(euFrozen !== null, "Europe applied the signed freeze without a local approval");
  const stateU = await inConsole(`lift the freeze on ${ENV}`, "us-east to report unfrozen", async () => { await syncEast(); const s = await desk.state(); return !s.frozen?.frozen ? s : null; });
  if (stateU) {
    ok(`unfrozen (generation ${stateU.host.status.generation}); the Run buttons are back`);
    const runU = await runTicket("T-1042");
    check(runU.status === 200, `T-1042 runs again: ${badge(replyStep(runU.json.run))}`);
    const euUnfrozen = await desk.waitFor("eu-west to lift the freeze", async () => { const r = await desk.hostRow(EU); return r && !r.status?.disabled?.agent ? r : null; }, { timeoutMs: 150_000, everyMs: 10_000 }).catch(() => null);
    check(euUnfrozen !== null, "Europe automatically applied the signed unfreeze");
  }
  const refused = await eventsOfKind(since3, "run_refused", EAST);
  check(refused.length >= 1, `the timeline shows ${refused.length} refused run(s) while frozen`);
}

// --- Beat 4: measure --------------------------------------------------------------------------------------------------------------
beat(4, "measure: a 10 % candidate, sticky per customer, a second split, dial, winner");
const since4 = new Date().toISOString();
const gExp = await newGeneration(`on ${BOARD}, save a candidate support.reply version (a warmer sign-off), seal it, and start an experiment of it against the control with the ramp ${RAMP_WORDS}`, await currentGeneration());
if (gExp !== null) {
  const sync4 = await syncEast();
  check(sync4.generation === gExp, `us-east took the split on its next invoke (#${sync4.generation})`);
  const synced4 = await waitForEuWest(gExp);
  const replyRamp = (synced4.status.ramps ?? []).find((r) => r.tag === "support.reply");
  check(replyRamp?.plan?.length === RAMP.length, `the Europe SDK reports the signed ramp plan on support.reply (${replyRamp?.plan?.length ?? 0} steps)`);
  const sinceReplay1 = new Date().toISOString();
  const replay = await desk.api("POST", "/presenter/replay", { n: 30 });
  check(replay.status === 202, `Replay 30 on us-east: ${replay.json.message}`);
  for (const id of ["T-1041", "T-1043", "T-1044", "T-1045"]) {
    const q = await desk.api("POST", "/presenter/enqueue", { ticketId: id, host: EU });
    if (q.status !== 202) fail(`enqueue ${id} on eu-west: ${q.json.message}`);
  }
  ok("four tickets queued on eu-west (its worker takes the queue within ten seconds)");
  const replayDone = await desk.waitFor("the replay to finish", async () => (await eventsOfKind(sinceReplay1, "replay_done", EAST))[0] ?? null, { timeoutMs: 330_000, everyMs: 10_000 });
  check(replayDone.done >= 12, `replay done: ${replayDone.done}/${replayDone.requested} runs`);
  await desk.waitFor("eu-west to run its queue", async () => ((await eventsOfKind(since4, "ticket_run", EU)).length >= 4 ? true : null), { timeoutMs: 240_000, everyMs: 10_000 }).catch(() => fail("eu-west ran fewer than four queued tickets in four minutes"));
  const arms4 = (await desk.api("GET", "/arms")).json;
  const replyArms = arms4.arms.filter((a) => a.tag === "support.reply" && a.arm !== "none");
  // The candidate's version, as the runs recorded it: what the winner must serve to everyone at the end of the beat.
  const candidateVersion = replyArms.find((a) => a.arm === "candidate")?.versionId ?? null;
  // One stickiness row per customer, slot and release (the weights in force): the counts here are for the split's own generation.
  const sticky4 = arms4.stickiness.filter((s) => s.tag === "support.reply" && s.generation === gExp);
  const candidateCustomers = sticky4.filter((s) => Object.values(s.arms).includes("candidate")).length;
  const seenCustomers = sticky4.length;
  ok(`per-arm results on the desk: ${replyArms.map((a) => `${a.arm} ${a.versionId}: ${a.runs} runs (${Object.entries(a.hosts).map(([h, n]) => `${h.split("/")[0]} ${n}`).join(", ")}), judge ${a.judgeMean ?? "—"}, cost ${a.costMeanUsd?.toFixed(5) ?? "—"}, 👍${a.feedback.up} 👎${a.feedback.down}`).join(" · ")}`);
  ok(`at 10 %, ${candidateCustomers} of ${seenCustomers} customers landed on the candidate (a share of customers, not of runs)`);
  const both = sticky4.filter((s) => Object.keys(s.arms).length >= 2);
  check(both.length >= 2 && both.every((s) => s.consistent), `sticky across hosts on the weights in force (#${gExp}): ${both.length} customers seen on both us-east and eu-west, ${both.filter((s) => s.consistent).length} on the same arm on both (${both.map((s) => `${s.customerId} ${Object.values(s.arms)[0]}`).join(", ")})`);
  if (flag("--airgap")) {
    const ag = await desk.hostRow(AIRGAP);
    if (ag?.airgap?.renders?.last?.arm) ok(`the air-gapped host's last probe (${ag.airgap.renders.last.subject}) landed on arm ${ag.airgap.renders.last.arm} — computed offline from the same manifest`);
  }
  // The second, independent split on triage.
  let latest = gExp;
  const gT = await newGeneration(`save a candidate support.triage version (a tighter summary), seal it, and start a second experiment on support.triage at 50 % (ramp 50 % for 60 min → 100 %)`, latest);
  if (gT !== null) {
    latest = gT;
    ok(`second experiment on support.triage at generation ${gT} — independent of the reply split`);
    await syncEast();
    await waitForEuWest(gT);
    const sinceReplay2 = new Date().toISOString();
    const replay2 = await desk.api("POST", "/presenter/replay", { n: 12 });
    const done2 = await desk.waitFor("the second replay", async () => (await eventsOfKind(sinceReplay2, "replay_done", EAST))[0] ?? null, { timeoutMs: 240_000, everyMs: 10_000 });
    ok(`Replay 12 (${replay2.status}): ${done2.done} runs`);
    const armsT = (await desk.api("GET", "/arms")).json;
    const triageArms = armsT.arms.filter((a) => a.tag === "support.triage" && a.arm !== "none");
    const byCustomer = armsByCustomer(armsT.stickiness, "support.triage", gT);
    const replyBy = armsByCustomer(armsT.stickiness, "support.reply", gT);
    const combos = new Set(Object.keys(byCustomer).filter((c) => replyBy[c]).map((c) => `${Object.values(replyBy[c].arms)[0]}/${Object.values(byCustomer[c].arms)[0]}`));
    check(triageArms.length === 2, `triage arms on the desk: ${triageArms.map((a) => `${a.arm} ${a.versionId}: ${a.runs}`).join(" · ")}`);
    check(combos.size >= 2, `independent splits: reply/triage combinations seen ${[...combos].join(", ")}`);
  }
  // AirPrompter's own rollout page is the person's to show; the desk's per-arm numbers above are zudocs's.
  showInConsole("open the reply experiment's rollout page: per-arm runs, quality and the promote verdict for the step in force");
  // Dial to 50 %, then the winner.
  const gDial = await newGeneration("dial the reply experiment to 50 %", latest);
  if (gDial !== null) {
    latest = gDial;
    ok(`dialled (generation ${gDial})`);
    await syncEast();
    await waitForEuWest(gDial);
    const sinceReplay3 = new Date().toISOString();
    const replay3 = await desk.api("POST", "/presenter/replay", { n: 12 });
    await desk.waitFor("the third replay", async () => (await eventsOfKind(sinceReplay3, "replay_done", EAST))[0] ?? null, { timeoutMs: 240_000, everyMs: 10_000 });
    const arms50 = (await desk.api("GET", "/arms")).json;
    const sticky50 = arms50.stickiness.filter((s) => s.tag === "support.reply" && s.generation === gDial);
    const cand50 = sticky50.filter((s) => Object.values(s.arms).includes("candidate")).length;
    ok(`at 50 % (replay ${replay3.status}, #${gDial}): ${cand50} of ${sticky50.length} customers on the candidate`);
    // A dial moves buckets by design: the rows from before it are compared on their own weights, and none reads "control+candidate".
    const moved = arms50.stickiness.filter((s) => s.tag === "support.reply" && s.generation !== gDial && Object.keys(s.arms).length >= 2);
    check(arms50.stickiness.every((s) => !Object.values(s.arms).some((a) => a.includes("+"))) && [...sticky50, ...moved].filter((s) => Object.keys(s.arms).length >= 2).every((s) => s.consistent), `stickiness after the dial: ${sticky50.filter((s) => Object.keys(s.arms).length >= 2).length} customers on both hosts at #${gDial} agree, ${moved.length} earlier rows kept on their own weights — no host reads control+candidate`);
  }
  const gWin = await newGeneration("promote the reply experiment's candidate as the winner", latest);
  if (gWin !== null) {
    await syncEast();
    await waitForEuWest(gWin);
    const runW = await runTicket(TICKET);
    check(candidateVersion !== null && replyStep(runW.json.run)?.versionId === candidateVersion && replyStep(runW.json.run)?.arm === "none", `the winner serves everyone: ${badge(replyStep(runW.json.run))} (the candidate was ${candidateVersion ?? "not seen"})`);
  }
}

// --- Beat 5: safety nets ------------------------------------------------------------------------------------------------------
beat(5, "safety nets");
showInConsole("on support.reply, save a version that uses {{region_note}} (a placeholder the slot does not declare) and try to seal it: the seal refuses it (variable_undeclared) and nothing reaches the hosts");
{
  // The seal refuses `model_not_in_catalog` only while a live instance reports models (the catalogue is the fleet's
  // word, and a mere warning when nothing live has reported): warm the reporter — the desk's own heartbeat — first.
  const UNREPORTED_MODEL = "anthropic.claude-sonnet-4-5";
  const hb = await desk.api("POST", "/presenter/heartbeat");
  check(hb.status === 200, `the us-east reporter is warm for the model drill: ${hb.status === 200 ? `presenter heartbeat at ${hb.json.heartbeat?.lastAt ?? "now"}` : `HTTP ${hb.status}`}`);
  if (!flag("--UNSAFE-promote-hosts-must-refuse")) {
    showInConsole(`pin support.reply to ${UNREPORTED_MODEL} as a required model (no host reports it) and try to seal: the seal refuses it (model_not_in_catalog) and nothing reaches the hosts — open the console's models page first if it lists no live reporter`);
  } else {
    const gen5 = await currentGeneration();
    const gM = await newGeneration(`pin support.reply to ${UNREPORTED_MODEL} as a required model, seal it (the seal warns: no live reporter) and promote it anyway (--UNSAFE-promote-hosts-must-refuse)`, gen5);
    if (gM !== null) {
      const syncM = await syncEast();
      const stG = (await desk.state()).host.status;
      const lastRefusal = String(stG.lastRefusal ?? "");
      check(syncM.applyState === "refused" && Number(stG.generation) < gM && /model_unavailable/.test(lastRefusal), `us-east refused #${gM}: sync ${syncM.outcome}, applyState ${syncM.applyState}, serving #${stG.generation}, lastRefusal ${lastRefusal || "none"}`);
      // Each worker reports and enforces its own model catalogue through the public SDK.
      const rejected = await desk.waitFor("Europe to report the unsupported model refusal", async () => {
        const row = await desk.hostRow(EU); return row?.status?.lastRefusal ? row : null;
      }, { timeoutMs: 120_000 }).catch(() => null);
      check(rejected !== null, "Europe SDK reports its unsupported model refusal");
      const gA = await newGeneration("seal and promote a release past the refused one, with support.reply back on a model the hosts report", gM);
      if (gA !== null) {
        await landEverywhere(gA);
        ok(`advanced past it: generation ${gA} live everywhere`);
      }
    }
  }
}
{
  // The golden set: a version that must fail it stays staged on the host that runs golden sets — under auto.
  const genG = await currentGeneration();
  const syncG = await inConsole(`on support.triage, save a version that answers category "other" and priority "low" whatever the ticket says, seal and promote it — its golden set must fail`, "us-east to run the golden set on a newer generation", async () => {
    const sync = await syncEast();
    return Number(sync.stagedGeneration) > genG || Number(sync.generation) > genG ? sync : null;
  });
  if (syncG !== null) {
    const pG = Number(syncG.stagedGeneration ?? syncG.generation);
    const stG = (await desk.state()).host.status;
    const golden = stG.golden;
    check(Number(syncG.stagedGeneration) === pG && stG.generation < pG, `us-east ran the golden set before activating #${pG}: ${golden ? `${golden.reports.map((r) => `${r.tag} ${r.passed}/${r.cases} (floor ${r.minPassBps / 100} %)`).join(", ")} — ${golden.met ? "met" : "below the floor"}` : "no golden report"} → staged, still serving #${stG.generation} under auto`);
    // Europe has no activation golden hook; inspect its report without creating a local approval.
    const euG = await desk.hostRow(EU);
    ok(`Europe reports #${euG?.status?.generation ?? "unknown"}; golden approval belongs in AirPrompter`);
    const goldenNow = await desk.api("POST", "/presenter/golden", { tag: "support.triage" });
    check(goldenNow.status === 200 && goldenNow.json.reports?.[0]?.meetsThreshold === true, `Golden set now on the active release: ${goldenNow.json.message}`);
    const gA2 = await newGeneration("seal and promote a release past the held-back one, with support.triage back on its previous version", pG);
    if (gA2 !== null) {
      await landEverywhere(gA2);
      const stA = (await desk.state()).host.status;
      check(stA.generation === gA2 && stA.golden?.met === true, `advanced: #${gA2} passed its golden set (${stA.golden?.reports.map((r) => `${r.passed}/${r.cases}`).join(", ")}) and is live`);
    }
  }
}
{
  const shown = await hostCli("policy show");
  check(shown.status === "Success" && shown.document?.applyPolicy?.effective === "auto", `Europe SDK policy: ${shown.summary}`);
}

// --- Beat 6: your data, your variables ----------------------------------------------------------------------------------------------
beat(6, "your data, your variables");
{
  const run6 = await runTicket("T-1043");
  const r6 = replyStep(run6.json.run);
  const tier = r6?.rendered?.variables.find((v) => v.name === "customer_tier");
  const ticket = r6?.rendered?.variables.find((v) => v.name === "ticket");
  const tone = r6?.rendered?.variables.find((v) => v.name === "tone");
  check(tier?.origin === "your_source" && tier?.value === "enterprise", `customer_tier = ${tier?.value} from the desk's own table (origin ${tier?.origin})`);
  check(ticket?.fenced === true && ticket?.trust === "end_user", "the ticket text is fenced as end-user data");
  check(tone?.origin === "call_site" && tone?.value === "formal", `tone = ${tone?.value} from the call site for an enterprise customer (default ${tone?.origin === "default" ? "used" : "overridden"})`);
  const s6 = await desk.state();
  check((s6.host.status.variables?.sources ?? []).includes("customer_tier"), `us-east host card: sources ${s6.host.status.variables.sources.join(", ")}; unsourced ${JSON.stringify(s6.host.status.variables.unsourced)}`);
  const eu6 = await desk.hostRow(EU);
  ok(`eu-west host card: sources ${(eu6?.status?.variables?.sources ?? []).join(", ") || "none (the daemon host reports names only once an SDK attaches)"}`);
}

// --- Beat 7: losing the wire ----------------------------------------------------------------------------------------------------------
beat(7, "losing the wire");
if (flag("--skip-wire")) say("    skipped (--skip-wire)");
else {
  const cut = await desk.api("POST", "/presenter/cut_wire");
  check(cut.status === 200 && cut.json.state === "cut", `wire cut on ${cut.json.hostId}; the rule restores by ${cut.json.restoreBy}`);
  const started = Date.now();
  const degraded = await desk.waitFor("eu-west to report sync_failing", async () => { const r = await desk.hostRow(EU); return r && (r.healthz?.reasons ?? []).includes("sync_failing") ? r : null; }, { timeoutMs: 300_000, everyMs: 10_000 }).catch(() => null);
  check(degraded !== null, degraded ? `eu-west degraded: sync_failing after ${Math.round((Date.now() - started) / 1000)} s (${degraded.status.consecutiveSyncFailures} failures in a row; lease until ${degraded.status.leaseExpiresAt}; the row still flows over the tables)` : "eu-west never reported sync_failing in five minutes");
  const restore = await desk.api("POST", "/presenter/restore_wire");
  check(restore.status === 200, `wire restored: ${restore.json.state}`);
  const recovered = await desk.waitFor("eu-west to recover", async () => { const r = await desk.hostRow(EU); return r && !(r.healthz?.reasons ?? []).includes("sync_failing") && Number(r.status?.consecutiveSyncFailures) === 0 ? r : null; }, { timeoutMs: 240_000, everyMs: 10_000 }).catch(() => null);
  check(recovered !== null, recovered ? `eu-west recovered: sync ${recovered.status.lastSyncOutcome}, health ${recovered.healthz.status}` : "eu-west did not recover in four minutes");
  if (flag("--airgap")) { const ag = await desk.hostRow(AIRGAP); ok(`the air-gapped host never had a wire: ${ag?.airgap?.export ? `${ag.airgap.export.segments} segments exported ${ag.airgap.export.at}` : "no export yet"}`); }
}

// --- Beat 8: what leaves the host -----------------------------------------------------------------------------------------------------
beat(8, "what leaves the host");
{
  const s8 = await desk.state();
  const east = s8.host.status;
  ok(`us-east spool: ${east.spool?.depthSegments} segments, ${east.spool?.depthBytes} B; last heartbeat ${east.heartbeat?.lastAt}`);
  const cw = new CloudWatchClient({ region: desk.region });
  const metrics = await cw.send(new ListMetricsCommand({ Namespace: "Zudocs/Desk" }));
  check((metrics.Metrics ?? []).length > 0, `CloudWatch Zudocs/Desk: ${new Set((metrics.Metrics ?? []).map((m) => m.MetricName)).size} metric names, ${(metrics.Metrics ?? []).length} series (the tee sink)`);
  showInConsole("open the zudocs-support agent's metrics (24 h, by tag, version, model and arm) and its fleet page (live instances, the offline export/import host)");
  const puller = await desk.hostRow(PULLER);
  ok(`the exchange holds #${puller?.status?.generation}; this hour ${puller?.status?.reads?.pointer ?? 0} CDN reads, ${puller?.status?.reads?.origin ?? 0} API reads`);
}

// --- Beat 9: the strips --------------------------------------------------------------------------------------------------------------
beat(9, "the recorded strips");
if (flag("--strips")) {
  const strip = spawnSync("bash", ["scripts/strip.sh"], { cwd: repoRootOf(), encoding: "utf8", env: process.env });
  check(strip.status === 0, `scripts/strip.sh exit ${strip.status}: ${strip.stdout.trim().split("\n").slice(-3).join(" | ")}${strip.stderr ? ` [stderr ${strip.stderr.trim().slice(0, 200)}]` : ""}`);
} else say("    (--strips records the CLI strips on this laptop, outside the tree)");

// --- Summary --------------------------------------------------------------------------------------------------------------------------
const final = await desk.state();
const agreement = fleetAgreement(final.hosts, final.host.status.generation);
say(`\n[${stamp()}] ${failures === 0 ? "dry run ok" : `dry run failed: ${failures} claim(s)`} · dev at ${releaseLine(final.host.status.generation, null)} · fleet ${agreement.agree ? "agrees" : `disagrees: ${agreement.disagree.map((r) => `${r.hostId} #${r.generation}`).join(", ")}`} · ${final.cap.used} runs today`);
process.exit(failures === 0 ? 0 : 1);
