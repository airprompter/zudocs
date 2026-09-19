#!/usr/bin/env node
/**
 * The nine beats of DEMO.md, performed against the live deployment in order, with every presenter click and console
 * act made for real and what the prospect would see asserted: the badge flips, the eu-west approval lands and
 * activates, the fleet agrees, the freeze greys every Run, the arms split and stick per customer on two hosts, the
 * ramp plan shows on the approval, the safety nets refuse in the platform's own words, the variables come from the
 * desk's table, the wire cut degrades and the restore recovers, the windows leave the host. Prints a transcript with
 * timings (ids, generations, codes, counts — never prompt text, never a key) and exits 1 when a claim fails. This is
 * the plan's gate: "a full dry run of the nine beats, twice in a row from a reset".
 *
 * Needs the session token (`AIRPROMPTER_SESSION_TOKEN`), the proof password (`ZUDOCS_PROOF_PASSWORD`) and the owner's
 * AWS profile (CloudWatch, the stack outputs). ~25 minutes; the wire beat is the slow one (`--skip-wire` for a
 * rehearsal), `--hosted` runs beat 1's hosted-staging step, `--airgap` expects the air-gapped host to be up
 * (`npm run airgap:up` first), `--strips` records the CLI strips at the end.
 *
 * @example
 * ```sh
 * eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'
 * npm run demo:dryrun -- --hosted --airgap --strips          # the full gate, then `npm run demo:reset`, then again
 * npm run demo:dryrun -- --skip-wire                         # a rehearsal
 * ```
 */
import { spawnSync } from "node:child_process";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { readConfig, secretFromEnv } from "./lib/config.mjs";
import { createConsole, withPin } from "./lib/console.mjs";
import { BEATS, RAMP, armsByCustomer, canonicalPins, fleetAgreement, releaseLine } from "./lib/demo.mjs";
import { connectDesk, repoRootOf, sleep } from "./lib/desk.mjs";

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
let token;
try {
  config = readConfig();
  token = secretFromEnv("AIRPROMPTER_SESSION_TOKEN", "the session token `airprompter login` prints");
} catch (error) {
  console.log(error.message);
  process.exit(2);
}
const ENV = config.environment;
const con = createConsole({ config, token, log: (e) => e.event === "platform_5xx_retry" && gap(`the platform answered ${e.status} on ${e.method} ${e.path}; retried once`) });
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

/** The eu-west approval for a generation: wait for the pending row, approve, wait for the activation. */
async function approveOnEuWest(generation, { timeoutMs = 180_000 } = {}) {
  const pending = await desk.waitFor(`eu-west to stage #${generation}`, async () => (await desk.approvals()).find((a) => a.hostId === EU && a.generation === generation && a.decision === "pending") ?? null, { timeoutMs });
  ok(`eu-west staged #${generation} at ${pending.stagedAt} — the Approvals page shows it${pending.ramps?.length ? ` with the ramp plan (${pending.ramps.map((r) => `${r.tag}: ${r.plan.map((p) => `${(p.weightBps[Math.max(0, r.arms.indexOf("candidate"))] ?? 0) / 100} %`).join(" → ")}`).join("; ")})` : ""}`);
  const decided = await desk.api("POST", `/approvals/${encodeURIComponent(pending.approvalId)}/approve`, {});
  check(decided.status === 200 && decided.json.already === false, `Approve clicked: ${decided.json.message}`);
  const activated = await desk.waitFor(`eu-west to activate #${generation}`, async () => (await desk.approvals()).find((a) => a.approvalId === pending.approvalId && a.decision === "activated") ?? null, { timeoutMs: 120_000 });
  ok(`eu-west live at ${activated.activatedAt} (${Math.round((Date.parse(activated.activatedAt) - Date.parse(activated.decidedAt)) / 1000)} s after the click)`);
  return { pending, activated };
}

/**
 * A row eu-west staged and nobody approved, after the next promotion staged in its place: the host settles it
 * `superseded` on its next tick, and a late click on it is refused (`409 approval_stale` while pending, `already`
 * once settled) — never an approval of a release the host no longer holds staged.
 */
async function expectSuperseded(row, why) {
  const settled = await desk.waitFor(`eu-west to settle the row for #${row.generation}`, async () => (await desk.approvals()).find((a) => a.approvalId === row.approvalId && a.decision !== "pending") ?? null, { timeoutMs: 90_000, everyMs: 5_000 }).catch(() => null);
  check(settled?.decision === "superseded", settled ? `eu-west settled the row for #${row.generation} ${settled.decision}: ${settled.outcome}` : `the row for #${row.generation} (${why}) is still pending ninety seconds after the next promotion landed`);
  const late = await desk.api("POST", `/approvals/${encodeURIComponent(row.approvalId)}/approve`, {});
  const refused = late.status === 409 || (late.status === 200 && late.json.already === true);
  check(refused, `a late click on that row is refused: HTTP ${late.status} ${late.json.error ?? ""} ${late.json.message ?? ""}`.replace(/\s+/g, " "));
}

/** A promotion landing on every host: us-east on the next invoke, eu-west by approval, the puller on a nudge, the air-gapped host from the exchange. */
async function landEverywhere(generation, { approve = true } = {}) {
  const sync = await syncEast();
  check(sync.generation === generation, `us-east synced on the next invoke: generation ${sync.generation} (${sync.outcome}, ${sync.applyState})`);
  if (approve) await approveOnEuWest(generation);
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
// API's 30-second cap once (DEMO.md › Honest notes says to click Sync now first) — the rehearsal does the same.
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
const v1 = await con.newVersion({ tag: BEATS.changeWords.tag, transform: BEATS.changeWords.transform, message: BEATS.changeWords.message });
const sealed1 = await con.seal({ environment: ENV, pins: withPin(await con.pins(ENV), BEATS.changeWords.tag, { versionId: v1.versionId }), notes: BEATS.changeWords.notes });
check(sealed1.release !== null, `sealed ${sealed1.release?.releaseDigest.slice(0, 20)}… with reply ${v1.versionId}${sealed1.blocked ? ` — BLOCKED ${JSON.stringify(sealed1.blocked)}` : ""}`);
const p1 = await con.promote({ environment: ENV, releaseDigest: sealed1.release.releaseDigest, notes: BEATS.changeWords.notes });
ok(`promoted: dev at generation ${p1.generation} at ${p1.updatedAt}`);
await landEverywhere(p1.generation);
const run1 = await runTicket(TICKET);
const r1 = replyStep(run1.json.run);
check(r1?.versionId === v1.versionId && r1?.generation === p1.generation, `re-run: the badge flipped to ${badge(r1)}`);
const changed = await eventsOfKind(since1, "release_changed", EAST);
check(changed.some((e) => e.generation === p1.generation), `the timeline shows release #${p1.generation} landing on us-east (${changed.length} row(s))`);
if (flag("--hosted")) {
  const hosted = await desk.api("POST", `/tickets/${TICKET}/hosted-run`);
  const h = hosted.json.run;
  if (hosted.status === 501) gap(`hosted staging is not configured on this deployment: ${hosted.json.message}`);
  else {
    ok(`hosted catalogue: staging generation ${h.catalogue.generation}, reply on ${h.catalogue.slot?.model} with ${JSON.stringify(h.catalogue.slot?.inference)}; ${h.subjectHash ? `subject hash computed on the desk (${h.subjectHash.slice(0, 12)}…)` : `no experiment on staging (${h.catalogue.experiments.length} listed), so no subject hash — the customer id never leaves the desk either way`}`);
    if (h.stream.result) ok(`hosted stream: ${h.stream.deltas.length} deltas, ${badge({ tag: "support.reply", versionId: h.stream.result.versionId, generation: h.stream.result.generation, model: h.stream.result.model, arm: h.stream.result.arm })} · ${h.stream.result.priceMicros} µ$ · feedback ${h.feedback?.accepted}`);
    else gap(`hosted run refused by the route: ${h.stream.refusal?.code} (HTTP ${h.stream.refusal?.status}) ${h.stream.refusal?.message} — recorded as such; platform issue #906`);
    check(h.compat?.request.temperature === 1.9 && h.compat.ignored.includes("temperature"), `compatible endpoint called with temperature ${h.compat?.request.temperature} (ignored by contract) beside the sealed ${JSON.stringify(h.catalogue.slot?.inference)}; it answered HTTP ${h.compat?.response.status}${h.compat?.response.runRef ? ` runRef ${h.compat.response.runRef.slice(0, 10)}…` : ""}`);
  }
}

// --- Beat 2: the fleet -----------------------------------------------------------------------------------------------------
beat(2, "the fleet");
const state2 = await desk.state();
const rows2 = Object.fromEntries(state2.hosts.map((h) => [h.hostId, h]));
check(rows2[EAST]?.status?.storageProtection === "kms", `us-east: Lambda, store key ${rows2[EAST]?.status?.storageProtection}, policy ${rows2[EAST]?.status?.applyPolicy?.effective} (${rows2[EAST]?.status?.applyPolicy?.source}), sdk ${rows2[EAST]?.sdk}`);
check(rows2[EU]?.status?.storageProtection === "file_key" && rows2[EU]?.status?.applyPolicy?.effective === "unlock_required", `eu-west: daemon host, store key ${rows2[EU]?.status?.storageProtection} (amber, doctor warns), policy ${rows2[EU]?.status?.applyPolicy?.effective} (${rows2[EU]?.status?.applyPolicy?.source}), workers node ${rows2[EU]?.worker?.attached ? "attached" : "detached"} / python ${rows2[EU]?.python?.attached ? "attached" : "detached"}`);
check(rows2[PULLER]?.kind === "puller", `ap-southeast: puller holds #${rows2[PULLER]?.status?.generation} in the exchange`);
if (flag("--airgap")) check(rows2[AIRGAP]?.kind === "airgapped" && rows2[AIRGAP]?.airgap?.keyPublished, `air-gapped host: no route out, key ${rows2[AIRGAP]?.airgap?.keyId?.slice(0, 8)}… born on the host, ${rows2[AIRGAP]?.airgap?.renders?.count} render probes filed as refused`);
else say(`    (air-gapped host ${rows2[AIRGAP] ? `row written ${rows2[AIRGAP].writtenAt} — ${Date.now() - Date.parse(rows2[AIRGAP].writtenAt) > 15 * 60_000 ? "down" : "up"}` : "never seen"}; --airgap to require it)`);
check(state2.host.models.length === 4, `models this host reports: ${state2.host.models.join(", ")}`);

// --- Beat 3: you activate, not us; then freeze --------------------------------------------------------------------------------
beat(3, "you activate, not us — and the freeze");
ok("the approval was the beat-1 approval above (staged → Approve → live with timestamps)");
const since3 = new Date().toISOString();
const frozen = await con.freeze({ environment: ENV, frozen: true, notes: "Zudocs demo, beat 3: freeze" });
ok(`frozen from the console (generation ${frozen.pointer.generation} carries the directive)`);
await syncEast();
const stateF = await desk.waitFor("us-east to report frozen", async () => { const s = await desk.state(); return s.frozen?.frozen ? s : null; }, { timeoutMs: 60_000, everyMs: 3_000 });
ok(`release bar: FROZEN — ${stateF.frozen.reason}`);
const runF = await runTicket("T-1042");
check(runF.status === 423 && runF.json.error === "frozen", `Run refused: HTTP ${runF.status} ${runF.json.error} — ${runF.json.message}`);
// eu-west: the daemon verifies the frozen generation and takes its directive, but an SDK attached over the socket
// renders from the ACTIVE release — the directive reaches the workers only when the frozen generation is unlocked
// (SDK issue: the daemon hands attached clients no standing directives). Try the honest path first, then approve.
let euFrozen = await desk.waitFor("eu-west to honour the freeze without an approval", async () => { const r = await desk.hostRow(EU); return r?.status?.disabled?.agent ? r : null; }, { timeoutMs: 60_000, everyMs: 10_000 }).catch(() => null);
let freezeApproved = false;
if (!euFrozen) {
  say("    eu-west's attached workers still render: the frozen generation is staged, not active — approving it (the daemon hands attached SDKs no standing directives — SDK #51)");
  await approveOnEuWest(frozen.pointer.generation).catch((error) => fail(`approving the frozen generation on eu-west: ${error.message}`));
  freezeApproved = true;
  euFrozen = await desk.waitFor("eu-west to honour the freeze once active", async () => { const r = await desk.hostRow(EU); return r?.status?.disabled?.agent ? r : null; }, { timeoutMs: 90_000, everyMs: 10_000 }).catch(() => null);
}
check(euFrozen !== null, euFrozen ? `eu-west honours the freeze ${freezeApproved ? "once the frozen generation is active (approved on the desk)" : "without an approval"} (disabled.agent on its row at ${euFrozen.writtenAt})` : "eu-west never reported the freeze on its row");
const unfrozen = await con.freeze({ environment: ENV, frozen: false, notes: "Zudocs demo, beat 3: unfreeze" });
await syncEast();
const stateU = await desk.waitFor("us-east to report unfrozen", async () => { const s = await desk.state(); return !s.frozen?.frozen ? s : null; }, { timeoutMs: 60_000, everyMs: 3_000 });
ok(`unfrozen (generation ${unfrozen.pointer.generation}); the Run buttons are back`);
const runU = await runTicket("T-1042");
check(runU.status === 200, `T-1042 runs again: ${badge(replyStep(runU.json.run))}`);
if (freezeApproved) await approveOnEuWest(unfrozen.pointer.generation).catch((error) => fail(`approving the unfreeze generation on eu-west: ${error.message}`));
const euUnfrozen = await desk.waitFor("eu-west to lift the freeze", async () => { const r = await desk.hostRow(EU); return r && !r.status?.disabled?.agent ? r : null; }, { timeoutMs: 150_000, everyMs: 10_000 }).catch(() => null);
check(euUnfrozen !== null, `eu-west lifted the freeze too${freezeApproved ? " (the unfreeze generation approved)" : " (the standing directive follows the latest verified manifest)"}`);
{
  const refused = await eventsOfKind(since3, "run_refused", EAST);
  check(refused.length >= 1, `the timeline shows ${refused.length} refused run(s) while frozen`);
}

// --- Beat 4: measure --------------------------------------------------------------------------------------------------------------
beat(4, "measure: a 10 % candidate, sticky per customer, a second split, dial, winner");
const since4 = new Date().toISOString();
const vC = await con.newVersion({ tag: BEATS.warmerSignoff.tag, transform: BEATS.warmerSignoff.transform, message: BEATS.warmerSignoff.message });
const sealedC = await con.seal({ environment: ENV, pins: withPin(await con.pins(ENV), BEATS.warmerSignoff.tag, { versionId: vC.versionId }), notes: BEATS.warmerSignoff.notes });
check(sealedC.release !== null, `candidate sealed: reply ${vC.versionId} (${sealedC.release?.releaseDigest.slice(0, 20)}…)`);
const exp = await con.experiments.start({ environment: ENV, candidateReleaseDigest: sealedC.release.releaseDigest, ramp: [...RAMP], notes: BEATS.warmerSignoff.notes });
const e1 = exp.experiment;
check(e1.weightBps === 1000 && (e1.plan?.length ?? 0) === 3, `experiment ${e1.experimentId} on ${e1.tag}: control ${e1.control.versionId} vs candidate ${e1.candidate.versionId} at ${e1.weightBps / 100} %, plan ${(e1.plan ?? []).map((s) => `${s.weightBps / 100} %`).join(" → ")}, generation ${exp.pointer.generation}`);
const sync4 = await syncEast();
check(sync4.generation === exp.pointer.generation, `us-east took the split on its next invoke (#${sync4.generation})`);
const approval4 = await approveOnEuWest(exp.pointer.generation);
check((approval4.pending.ramps ?? []).some((r) => r.tag === e1.tag && r.plan.length === 3), "the Approvals page showed the whole ramp plan on that one approval");
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
const candidateCustomers = arms4.stickiness.filter((s) => s.tag === "support.reply" && Object.values(s.arms).includes("candidate")).length;
const seenCustomers = arms4.stickiness.filter((s) => s.tag === "support.reply").length;
ok(`per-arm results on the desk: ${replyArms.map((a) => `${a.arm} ${a.versionId}: ${a.runs} runs (${Object.entries(a.hosts).map(([h, n]) => `${h.split("/")[0]} ${n}`).join(", ")}), judge ${a.judgeMean ?? "—"}, cost ${a.costMeanUsd?.toFixed(5) ?? "—"}, 👍${a.feedback.up} 👎${a.feedback.down}`).join(" · ")}`);
ok(`at 10 %, ${candidateCustomers} of ${seenCustomers} customers landed on the candidate (a share of customers, not of runs)`);
const both = arms4.stickiness.filter((s) => s.tag === "support.reply" && Object.keys(s.arms).length >= 2);
check(both.length >= 2 && both.every((s) => s.consistent), `sticky across hosts: ${both.length} customers seen on both us-east and eu-west, ${both.filter((s) => s.consistent).length} on the same arm on both (${both.map((s) => `${s.customerId} ${Object.values(s.arms)[0]}`).join(", ")})`);
if (flag("--airgap")) {
  const ag = await desk.hostRow(AIRGAP);
  if (ag?.airgap?.renders?.last?.arm) ok(`the air-gapped host's last probe (${ag.airgap.renders.last.subject}) landed on arm ${ag.airgap.renders.last.arm} — computed offline from the same manifest`);
}
// The second, independent split on triage.
const vT = await con.newVersion({ tag: BEATS.tighterTriage.tag, transform: BEATS.tighterTriage.transform, message: BEATS.tighterTriage.message });
const sealedT = await con.seal({ environment: ENV, pins: withPin(await con.pins(ENV), BEATS.tighterTriage.tag, { versionId: vT.versionId }), notes: BEATS.tighterTriage.notes });
let expT = null;
try {
  expT = await con.experiments.start({ environment: ENV, candidateReleaseDigest: sealedT.release.releaseDigest, ramp: [{ weightBps: 5000, holdMinutes: 60 }, { weightBps: 10000 }], notes: BEATS.tighterTriage.notes });
  ok(`second experiment ${expT.experiment.experimentId} on ${expT.experiment.tag} at ${expT.experiment.weightBps / 100} %, generation ${expT.pointer.generation} — independent of the reply split`);
  await syncEast();
  await approveOnEuWest(expT.pointer.generation);
  const sinceReplay2 = new Date().toISOString();
  const replay2 = await desk.api("POST", "/presenter/replay", { n: 12 });
  const done2 = await desk.waitFor("the second replay", async () => (await eventsOfKind(sinceReplay2, "replay_done", EAST))[0] ?? null, { timeoutMs: 240_000, everyMs: 10_000 });
  ok(`Replay 12 (${replay2.status}): ${done2.done} runs`);
  const armsT = (await desk.api("GET", "/arms")).json;
  const triageArms = armsT.arms.filter((a) => a.tag === "support.triage" && a.arm !== "none");
  const byCustomer = armsByCustomer(armsT.stickiness, "support.triage");
  const replyBy = armsByCustomer(armsT.stickiness, "support.reply");
  const combos = new Set(Object.keys(byCustomer).filter((c) => replyBy[c]).map((c) => `${Object.values(replyBy[c].arms)[0]}/${Object.values(byCustomer[c].arms)[0]}`));
  check(triageArms.length === 2, `triage arms on the desk: ${triageArms.map((a) => `${a.arm} ${a.versionId}: ${a.runs}`).join(" · ")}`);
  check(combos.size >= 2, `independent splits: reply/triage combinations seen ${[...combos].join(", ")}`);
} catch (error) {
  fail(`the second split was refused: ${error.message.slice(0, 300)}`);
}
// AirPrompter's own rollout page.
{
  // The page reads the step's window once the step has held long enough (the platform's rule, minutes); two minutes
  // in it can honestly say "not yet" — the claim is that it answers for this experiment, and what it says is printed.
  const doc = await con.experiments.read({ environment: ENV, experimentId: e1.experimentId });
  const line = `AirPrompter's rollout page: control ${doc.arms.control.runs} runs / candidate ${doc.arms.candidate.runs} runs (window ${doc.window.usageSource}); quality ${doc.arms.control.quality ? `${doc.arms.control.quality.signal} ${doc.arms.control.quality.valueBps / 100} %` : "—"} vs ${doc.arms.candidate.quality ? `${doc.arms.candidate.quality.valueBps / 100} %` : "—"}; evaluation ${doc.evaluation?.decision ?? "none yet"}; promote: ${doc.promote.reason}`;
  check(doc.experiment?.experimentId === e1.experimentId && !!doc.arms?.control && !!doc.arms?.candidate, line);
  if (doc.arms.control.runs + doc.arms.candidate.runs === 0) gap("the rollout page has no window for this step yet (the step must hold before it reads one); in a session the read comes minutes after the start");
}
// Dial to 50 %, then the winner.
const dialed = await con.experiments.weights({ environment: ENV, experimentId: e1.experimentId, action: "set", weightBps: 5000, notes: "Zudocs demo, beat 4: dialled to 50 %" });
check(dialed.experiment.weightBps === 5000, `dialled to ${dialed.experiment.weightBps / 100} % (generation ${dialed.pointer.generation})`);
await syncEast();
await approveOnEuWest(dialed.pointer.generation);
const sinceReplay3 = new Date().toISOString();
const replay3 = await desk.api("POST", "/presenter/replay", { n: 12 });
await desk.waitFor("the third replay", async () => (await eventsOfKind(sinceReplay3, "replay_done", EAST))[0] ?? null, { timeoutMs: 240_000, everyMs: 10_000 });
const arms50 = (await desk.api("GET", "/arms")).json;
const cand50 = arms50.stickiness.filter((s) => s.tag === "support.reply" && Object.values(s.arms).includes("candidate")).length;
ok(`at 50 % (replay ${replay3.status}): ${cand50} of ${arms50.stickiness.filter((s) => s.tag === "support.reply").length} customers on the candidate`);
const winner = await con.promote({ environment: ENV, releaseDigest: e1.candidate.releaseDigest, notes: "Zudocs demo, beat 4: the candidate promoted as the winner" });
const afterWin = await con.experiments.read({ environment: ENV, experimentId: e1.experimentId });
check(afterWin.experiment.status === "promoted", `winner promoted: generation ${winner.generation}; the experiment is ${afterWin.experiment.status}`);
await syncEast();
await approveOnEuWest(winner.generation);
const runW = await runTicket(TICKET);
check(replyStep(runW.json.run)?.versionId === vC.versionId && replyStep(runW.json.run)?.arm === "none", `the winner serves everyone: ${badge(replyStep(runW.json.run))}`);

// --- Beat 5: safety nets ------------------------------------------------------------------------------------------------------
beat(5, "safety nets");
{
  const vP = await con.newVersion({ tag: BEATS.undeclaredPlaceholder.tag, transform: BEATS.undeclaredPlaceholder.transform, message: BEATS.undeclaredPlaceholder.message });
  const sealedP = await con.seal({ environment: ENV, pins: withPin(await con.pins(ENV), BEATS.undeclaredPlaceholder.tag, { versionId: vP.versionId }), notes: BEATS.undeclaredPlaceholder.notes });
  const blocker = sealedP.blocked?.blockers.find((b) => b.code === "variable_undeclared");
  check(!!blocker, `the seal refused ${vP.versionId}: ${blocker ? `${blocker.code} — ${blocker.detail}` : `NOT refused (${JSON.stringify(sealedP.blocked ?? sealedP.release?.releaseDigest).slice(0, 200)})`}`);
}
{
  const pins = withPin(await con.pins(ENV), BEATS.unreportedModel.tag, { model: BEATS.unreportedModel.model });
  const sealedM = await con.seal({ environment: ENV, pins, notes: BEATS.unreportedModel.notes, modelRequired: [BEATS.unreportedModel.tag] });
  if (sealedM.blocked) ok(`the seal refused a required model no host reports (the environment's catalogue is what the fleet reports; nothing to advance past): ${sealedM.blocked.blockers.map((b) => `${b.code}${b.detail ? ` (${b.detail})` : ""}`).join(", ")}`);
  else {
    ok(`the seal accepted the unreported model with a warning (${sealedM.warnings.map((w) => w.code).join(", ")}); promoting to let the hosts refuse it`);
    const pM = await con.promote({ environment: ENV, releaseDigest: sealedM.release.releaseDigest, notes: BEATS.unreportedModel.notes });
    const syncM = await syncEast();
    const eastRefused = /model_unavailable|model/.test(String(syncM.outcome ?? "")) || syncM.applyState === "refused" || (await desk.state()).host.status.lastRefusal;
    check(!!eastRefused, `us-east refused #${pM.generation}: sync ${syncM.outcome}, applyState ${syncM.applyState}, lastRefusal ${(await desk.state()).host.status.lastRefusal}`);
    // The daemon host declares no catalogue (airprompterd has no --models flag; the attached workers' catalogue never
    // reaches the sync), so it cannot refuse: it STAGES the release for approval — a trap the presenter must not spring.
    const euStaged = await desk.waitFor("eu-west to stage the unreported-model release", async () => (await desk.approvals()).find((a) => a.hostId === EU && a.generation === pM.generation && a.decision === "pending") ?? null, { timeoutMs: 120_000 }).catch(() => null);
    check(euStaged !== null, euStaged ? `eu-west STAGED #${pM.generation} instead of refusing (the daemon declares no models — SDK #51): not approved; the next promotion supersedes it` : "eu-west neither refused nor staged the release within two minutes");
    const fleet = await con.fleet(ENV);
    ok(`AirPrompter's fleet page: ${fleet.summary.modelUnavailable} instance(s) report the model unavailable, ${fleet.summary.refused} refused, ${fleet.summary.staged} staged`);
    // Move past it: a fresh canonical generation.
    const vA = await con.newVersion({ tag: "support.escalate.summary", inference: (c) => ({ ...c, maxOutputTokens: Number(c.maxOutputTokens ?? 400) + 1 }), message: "Beat 5: past the refused release" });
    const sealedA = await con.seal({ environment: ENV, pins: canonicalPins(config, { "support.escalate.summary": { versionId: vA.versionId }, "support.reply": { versionId: vC.versionId } }), notes: "Zudocs demo, beat 5: past the refused release" });
    const pA = await con.promote({ environment: ENV, releaseDigest: sealedA.release.releaseDigest, notes: "Zudocs demo, beat 5: advance" });
    await landEverywhere(pA.generation);
    ok(`advanced past it: generation ${pA.generation} live everywhere`);
    if (euStaged) await expectSuperseded(euStaged, "the unreported-model release");
  }
}
{
  // The golden set: a version that must fail it stays staged on the host that runs golden sets — under auto.
  const vG = await con.newVersion({ tag: BEATS.goldenFail.tag, transform: BEATS.goldenFail.transform, message: BEATS.goldenFail.message });
  const sealedG = await con.seal({ environment: ENV, pins: withPin(await con.pins(ENV), BEATS.goldenFail.tag, { versionId: vG.versionId }), notes: BEATS.goldenFail.notes });
  const pG = await con.promote({ environment: ENV, releaseDigest: sealedG.release.releaseDigest, notes: BEATS.goldenFail.notes });
  const syncG = await syncEast();
  const stG = (await desk.state()).host.status;
  const golden = stG.golden;
  check(syncG.stagedGeneration === pG.generation && stG.generation < pG.generation, `us-east ran the golden set before activating #${pG.generation}: ${golden ? `${golden.reports.map((r) => `${r.tag} ${r.passed}/${r.cases} (floor ${r.minPassBps / 100} %)`).join(", ")} — ${golden.met ? "met" : "below the floor"}` : "no golden report"} → staged, still serving #${stG.generation} under auto`);
  const euG = await desk.waitFor("eu-west to stage the golden-failing release", async () => (await desk.approvals()).find((a) => a.hostId === EU && a.generation === pG.generation && a.decision === "pending") ?? null, { timeoutMs: 150_000 }).catch(() => null);
  check(euG !== null, euG ? `eu-west staged #${pG.generation} for approval — not approved (the daemon has no golden hook; the desk shows us-east's verdict)` : "eu-west never staged it");
  const goldenNow = await desk.api("POST", "/presenter/golden", { tag: "support.triage" });
  check(goldenNow.status === 200 && goldenNow.json.reports?.[0]?.meetsThreshold === true, `Golden set now on the active release: ${goldenNow.json.message}`);
  const vA2 = await con.newVersion({ tag: "support.escalate.summary", inference: (c) => ({ ...c, maxOutputTokens: Number(c.maxOutputTokens ?? 400) + 1 }), message: "Beat 5: past the golden-failing release" });
  const sealedA2 = await con.seal({ environment: ENV, pins: canonicalPins(config, { "support.escalate.summary": { versionId: vA2.versionId }, "support.reply": { versionId: vC.versionId } }), notes: "Zudocs demo, beat 5: past the golden-failing release" });
  const pA2 = await con.promote({ environment: ENV, releaseDigest: sealedA2.release.releaseDigest, notes: "Zudocs demo, beat 5: advance" });
  await landEverywhere(pA2.generation);
  if (euG) await expectSuperseded(euG, "the golden-failing release");
  const stA = (await desk.state()).host.status;
  check(stA.generation === pA2.generation && stA.golden?.met === true, `advanced: #${pA2.generation} passed its golden set (${stA.golden?.reports.map((r) => `${r.passed}/${r.cases}`).join(", ")}) and is live`);
}
{
  // The host's shell, one click: policy show, then rollback (a forced downgrade), then the next promotion carries it forward.
  const shown = await hostCli("policy show");
  const pol = shown.document?.applyPolicy;
  check(shown.status === "Success" && pol?.effective === "unlock_required" && pol?.manifestSaid === "auto", `zudocs-cli policy show on eu-west (via Run Command, on the timeline): ${shown.summary}`);
  const rolled = await hostCli("rollback");
  check(rolled.status === "Success" && rolled.document?.forced === true, `zudocs-cli rollback on eu-west: ${rolled.summary}`);
  const held = await desk.waitFor("eu-west to report the forced downgrade", async () => { const r = await desk.hostRow(EU); return r?.status?.forcedDowngrade ? r : null; }, { timeoutMs: 90_000, everyMs: 5_000 }).catch(() => null);
  check(held !== null, held ? `eu-west card: forced downgrade, serving #${held.status.generation}` : "eu-west never reported the forced downgrade");
  const fleet = await con.fleet(ENV);
  const forcedOnFleet = fleet.instances.filter((i) => i.claimed?.localRollback?.forced).length;
  ok(`AirPrompter's fleet page: ${forcedOnFleet} instance(s) with a forced local rollback (the host reports it on its next heartbeat, up to five minutes; read ${forcedOnFleet ? "after" : "before"} that)`);
  const vA3 = await con.newVersion({ tag: "support.escalate.summary", inference: (c) => ({ ...c, maxOutputTokens: Number(c.maxOutputTokens ?? 400) + 1 }), message: "Beat 5: past the rollback" });
  const sealedA3 = await con.seal({ environment: ENV, pins: canonicalPins(config, { "support.escalate.summary": { versionId: vA3.versionId }, "support.reply": { versionId: vC.versionId } }), notes: "Zudocs demo, beat 5: past the rollback" });
  const pA3 = await con.promote({ environment: ENV, releaseDigest: sealedA3.release.releaseDigest, notes: "Zudocs demo, beat 5: advance past the rollback" });
  await landEverywhere(pA3.generation);
  ok(`the next promotion (#${pA3.generation}) carried eu-west forward — held back until something newer was promoted`);
}
say("    apply --force and apply.window are laptop drills: docs/strips/cli.txt (rollback, the older bundle refused, apply --force staged and stamped; the second-run form needs an earlier generation in ~/.cache/zudocs/strips) and docs/strips/apply-window.txt (--strips records both now)");

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
  const m = await con.metrics(ENV);
  const rowsWithArm = (m.rows ?? []).filter((r) => r.arm && r.arm !== "none");
  check((m.rows ?? []).length > 0, `AirPrompter metrics (24 h): ${(m.rows ?? []).length} rows by tag/version/model/arm, ${rowsWithArm.length} on an arm; runs ${m.tiles?.runs ?? "—"}`);
  const fleet = await con.fleet(ENV);
  ok(`AirPrompter fleet page: ${fleet.summary.live} live instances, ${fleet.instances.filter((i) => i.syncMode === "offline").length} offline (export/import), generation ${fleet.generation}`);
  const puller = await desk.hostRow(PULLER);
  ok(`the exchange holds #${puller?.status?.generation}; this hour ${puller?.status?.reads?.pointer ?? 0} CDN reads, ${puller?.status?.reads?.origin ?? 0} API reads`);
}

// --- Beat 9: the strips --------------------------------------------------------------------------------------------------------------
beat(9, "the recorded strips");
if (flag("--strips")) {
  const strip = spawnSync("bash", ["scripts/strip.sh"], { cwd: repoRootOf(), encoding: "utf8", env: process.env });
  check(strip.status === 0, `scripts/strip.sh exit ${strip.status}: ${strip.stdout.trim().split("\n").slice(-3).join(" | ")}${strip.stderr ? ` [stderr ${strip.stderr.trim().slice(0, 200)}]` : ""}`);
} else say("    (--strips records docs/strips/*.txt from the CLI beats on this laptop)");

// --- Summary --------------------------------------------------------------------------------------------------------------------------
const final = await desk.state();
const agreement = fleetAgreement(final.hosts, final.host.status.generation);
say(`\n[${stamp()}] ${failures === 0 ? "dry run ok" : `dry run failed: ${failures} claim(s)`} · dev at ${releaseLine(final.host.status.generation, null)} · fleet ${agreement.agree ? "agrees" : `disagrees: ${agreement.disagree.map((r) => `${r.hostId} #${r.generation}`).join(", ")}`} · ${final.cap.used} runs today`);
process.exit(failures === 0 ? 0 : 1);
