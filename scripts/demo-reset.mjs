#!/usr/bin/env node
/**
 * Reset means advance. After a session the fleet holds whatever the beats left: an experiment, a freeze, a pinned
 * policy, a forced downgrade, a queue of nudges, a cut wire, a day's records. Nothing is restored — generations are
 * monotonic, a tightened pin loosens only on the host, a rollback holds a host back until something newer lands —
 * so the reset moves forward. On the zudocs side it does it all: waits for a replay in flight, purges the nudge
 * queue (then waits the minute SQS asks for before the next message), restores the wire, clears the desk's records
 * and re-seeds the inbox, resets the day counter and bumps the desk Lambda's `STATE_EPOCH` (new containers start
 * from an empty store). The AirPrompter side is a person's act in the console, never this script's: it prints the
 * one instruction (end any experiment, lift a freeze, promote a fresh generation), then waits until the
 * environment's public edge pointer names a generation newer than the one read at the start (fifteen minutes; on a
 * timeout the zudocs side still finishes and the reset exits 1), nudges the fleet,
 * approves the new generation on eu-west through the desk, and ends by checking that every status row agrees on
 * it. An approval that does not land in time is recorded and the reset goes on; the fleet check reports it; when
 * eu-west's status row is stale (the host down or replacing itself) it is optional there too. `--no-wait` does the
 * zudocs side, prints the instruction and stops without waiting for the console.
 * Idempotent: every step reads before it writes and says what it did or found done. Needs the proof password
 * (`ZUDOCS_PROOF_PASSWORD`) and the owner's AWS profile; no AirPrompter credential at all.
 *
 * @example
 * ```sh
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'
 * npm run demo:reset                 # ~4 minutes plus the console act: the fleet agreeing on a fresh generation
 * npm run demo:reset -- --no-wait    # the zudocs side only; promote in AirPrompter afterwards
 * npm run demo:reset -- --dry-run    # say what would be done; touch nothing
 * ```
 */
import { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { PurgeQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { readConfig } from "./lib/config.mjs";
import { edgeGeneration, fleetAgreement } from "./lib/demo.mjs";
import { connectDesk, sleep, stackOutputs } from "./lib/desk.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noWait = args.includes("--no-wait");
/** How long a person has for the console act before the reset stops waiting (it says so, finishes the zudocs side and exits 1). */
const CONSOLE_WAIT_MS = 15 * 60_000;
const say = (line) => console.log(line);
const did = (line) => say(`  ✓ ${line}`);
const found = (line) => say(`  · ${line}`);
const startedAt = Date.now();

let config;
try {
  config = readConfig();
} catch (error) {
  console.log(error.message);
  process.exit(2);
}
const ENV = config.environment;
const desk = await connectDesk();
const fleetRegion = process.env.ZUDOCS_FLEET_REGION ?? "ap-southeast-1";
const EU = "eu-west-1/ec2";

// --- 0. the eu-west host is awake (phase 8: the nightly schedule stops it; nothing but the owner starts it) ----------
say("0. the eu-west host");
{
  const euRow = await desk.hostRow(EU);
  const power = euRow?.powerView ?? null;
  if (!power || power.phase === "awake") found(power ? "eu-west is awake" : "eu-west has no power marker (never slept)");
  else if (power.phase === "started" || power.phase === "waking") found(`eu-west is ${power.label} since ${power.since}; its approvals in step 5 wait up to three minutes each`);
  else {
    say(`  ✗ eu-west is ${power.label} since ${power.since} (${power.by}): wake it first — the desk's "Wake the fleet" or \`npm run host:wake -- --wait\` (about three minutes) — and run the reset again`);
    process.exit(3);
  }
}

// --- 1. where the environment stands: the generation every later wait must pass ----------------------------------------
say("1. the environment");
/** The newest generation zudocs can see without a credential: the public edge pointer, else what us-east serves after a sync. */
const currentGeneration = async () => (await edgeGeneration(config.edgePointerUrl)) ?? Number((await desk.api("POST", "/presenter/sync")).json?.generation ?? NaN);
const startGeneration = await currentGeneration();
{
  const state = await desk.state();
  const ramps = (await desk.hostRow(EU))?.status?.ramps ?? [];
  found(`${ENV} at #${Number.isFinite(startGeneration) ? startGeneration : "?"} (${config.edgePointerUrl ? "the edge pointer" : "us-east after a sync"}) · frozen ${state.frozen?.frozen ? "yes" : "no"} · ${ramps.length} ramp plan(s) reported by eu-west`);
  if (!Number.isFinite(startGeneration)) { say("  ✗ no generation is readable (no edge pointer and no us-east row); deploy the desk or set edgePointerUrl"); process.exit(1); }
}

// --- 3. the us-east host's policy (the one a drill can loosen or tighten) --------------------------------------------
say("3. policies");
{
  const state = await desk.state();
  const east = state.host.status?.applyPolicy;
  if (east?.effective === "auto") found(`us-east: auto (${east.source})`);
  else found(`us-east: policy ${east?.effective} (${east?.source}); manage release policy in AirPrompter or host maintenance`);
  found("eu-west: workers automatically sync AirPrompter releases; no local release override");
}

// --- 3b. a replay in flight keeps writing runs for up to five minutes: let it finish before the tables are cleared ------
say("3b. runs in flight");
{
  // One window for both counts, and the wait looks for a replay_done written AFTER the newest queued replay — a
  // done row from an earlier replay must not stand in for the one still writing.
  const recent = await desk.eventsSince(new Date(Date.now() - 6 * 60_000).toISOString());
  const queued = recent.filter((e) => e.kind === "presenter" && e.action === "replay");
  const done = recent.filter((e) => e.kind === "replay_done");
  const newestQueuedAt = queued.map((e) => e.at).sort().at(-1) ?? null;
  const doneAfter = (rows) => rows.filter((e) => e.kind === "replay_done" && newestQueuedAt !== null && e.at > newestQueuedAt);
  if (queued.length <= done.length || doneAfter(recent).length > 0) found("no replay in flight");
  else if (dryRun) found(`would wait for the replay queued at ${newestQueuedAt} (${queued.length} queued, ${done.length} done in six minutes)`);
  else {
    const finished = await desk.waitFor("the replay in flight to finish", async () => doneAfter(await desk.eventsSince(newestQueuedAt))[0] ?? null, { timeoutMs: 330_000, everyMs: 10_000 }).catch(() => null);
    if (finished) did(`the replay queued at ${newestQueuedAt} finished: ${finished.done}/${finished.requested} runs`);
    else found("the replay did not report done within five and a half minutes; going on");
  }
}

// --- 4. the nudge queue and the wire --------------------------------------------------------------------------------
say("4. the nudge queue and the wire");
{
  const fleet = await stackOutputs(fleetRegion, "ZudocsFleet");
  if (!fleet?.NudgeQueueUrl) found("no fleet stack: no queue to purge");
  else if (dryRun) found(`would purge ${fleet.NudgeQueueUrl.split("/").pop()}`);
  else {
    try {
      await new SQSClient({ region: fleetRegion }).send(new PurgeQueueCommand({ QueueUrl: fleet.NudgeQueueUrl }));
      did(`purged ${fleet.NudgeQueueUrl.split("/").pop()}; waiting 60 s (a message sent within a minute of a purge may be deleted with it)`);
      await sleep(60_000);
    } catch (error) {
      if (error.name === "PurgeQueueInProgress") found("a purge is already in progress (one per minute)");
      else throw error;
    }
  }
  const state = await desk.state();
  if (!state.features?.wire) found("no wire function on this deployment");
  else if (dryRun) found("would restore the wire");
  else {
    const r = await desk.api("POST", "/presenter/restore_wire");
    if (r.status === 200) did(`wire: ${r.json.state ?? "restored"} on ${r.json.hostId ?? "the host"}`);
    else found(`wire: ${r.json.message ?? JSON.stringify(r.json).slice(0, 200)}`);
  }
}

// --- 5. a fresh generation: the console act, then each host takes it ----------------------------------------------------
say("5. a fresh generation");
const instruction = `In AirPrompter, open the zudocs-support agent's board (${ENV}): end any running experiment (roll back to the control), lift the freeze if it is on, then seal and promote a fresh ${ENV} release — any real change, such as a new version of one slot`;
const promoted = [];
/** How eu-west did in step 5, for step 8: `stale` (its row too old to wait on — optional there), `late` (a wait ran out — step 8 reports it), or ok. */
const euWest = { stale: false, late: [] };
const approveOnEuWest = async (generation) => {
  const euRow = await desk.hostRow(EU);
  if (!euRow) { found("eu-west has no status row; nothing to approve"); euWest.stale = true; return null; }
  if (Date.now() - Date.parse(euRow.writtenAt) > 15 * 60_000) { found(`eu-west's row is ${Math.round((Date.now() - Date.parse(euRow.writtenAt)) / 60_000)} min old (the host is down or replacing itself); not waiting for its approval — the fleet check treats it as optional`); euWest.stale = true; return null; }
  // Either the pending row appears, or the host is already at the generation (an operator's unlock, a window, or a
  // row settled by the worker): both are "done".
  // A wait that runs out is not the end of the reset: the later steps (the records, the epoch, the fleet check) are
  // still due, and the fleet check is where a host that did not land is reported.
  const late = (what) => { found(`eu-west did not ${what} #${generation} in time; going on — the fleet check reports it`); euWest.late.push(generation); return null; };
  const found_ = await desk.waitFor(`eu-west to stage #${generation}`, async () => {
    const row = (await desk.approvals()).find((a) => a.hostId === EU && a.generation === generation);
    if (row?.decision === "pending") return { pending: row };
    if (row && ["approved", "activated", "superseded"].includes(row.decision)) return { settled: row };
    const host = await desk.hostRow(EU);
    if (Number(host?.status?.generation) >= generation) return { live: host };
    return null;
  }, { timeoutMs: 180_000 }).catch(() => null);
  if (!found_) return late("stage");
  if (found_.live) { found(`eu-west already serves #${found_.live.status.generation}`); return null; }
  if (found_.settled) { found(`eu-west's row for #${generation} is already ${found_.settled.decision}`); return found_.settled; }
  const pending = found_.pending;
  const decided = await desk.api("POST", `/approvals/${encodeURIComponent(pending.approvalId)}/approve`, {});
  if (decided.status !== 200) { say(`  ✗ approve #${generation} on eu-west refused: HTTP ${decided.status} ${decided.json.error ?? ""} ${decided.json.message ?? ""}`); euWest.late.push(generation); return null; }
  did(`approved #${generation} on eu-west (${decided.json.already ? "already decided" : "decided now"})`);
  const activated = await desk.waitFor(`eu-west to activate #${generation}`, async () => (await desk.approvals()).find((a) => a.approvalId === pending.approvalId && ["activated", "superseded"].includes(a.decision)) ?? null, { timeoutMs: 120_000 }).catch(() => null);
  if (!activated) return late("activate");
  did(`eu-west ${activated.decision} #${generation} at ${activated.activatedAt ?? activated.updatedAt}`);
  return activated;
};
if (dryRun) found(`would ask: ${instruction}; then wait for a generation newer than #${startGeneration}`);
else if (noWait) say(`  → ${instruction}. (--no-wait: not waiting; the hosts take it on their own, and eu-west's approval is on the desk.)`);
else {
  say(`  → ${instruction}.`);
  found(`waiting up to ${CONSOLE_WAIT_MS / 60_000} min for the edge pointer to name a generation newer than #${startGeneration}`);
  const generation = await desk.waitFor(`a generation newer than #${startGeneration}`, async () => { const g = await currentGeneration(); return g > startGeneration ? g : null; }, { timeoutMs: CONSOLE_WAIT_MS, everyMs: 10_000 }).catch(() => null);
  if (generation === null) say(`  ✗ no generation newer than #${startGeneration} within ${CONSOLE_WAIT_MS / 60_000} min — was the release promoted in AirPrompter? The zudocs side goes on; the fleet check reports it`);
  else {
    did(`AirPrompter promoted #${generation}`);
    promoted.push(generation);
    const nudged = await desk.api("POST", "/presenter/nudge");
    found(nudged.status === 202 ? `nudged the fleet (${nudged.json.messageId})` : `nudge: ${nudged.json.message ?? nudged.status}`);
    await desk.api("POST", "/presenter/sync");
    await approveOnEuWest(generation);
  }
}

// --- 6. the desk's records and the day counter -------------------------------------------------------------------------
say("6. the desk's records");
if (dryRun) found("would clear runs, feedback, approvals, events, counters and re-seed");
else {
  const r = await desk.api("POST", "/presenter/reset");
  if (r.status !== 200) { say(`  ✗ reset refused: ${JSON.stringify(r.json).slice(0, 300)}`); process.exit(1); }
  did(r.json.message);
}

// --- 7. STATE_EPOCH: new containers, empty stores ----------------------------------------------------------------------
say("7. the desk Lambda's STATE_EPOCH");
// The container answering now, before the bump: step 8's "was" — read after the bump it would name a new container too.
const beforeEpoch = dryRun ? null : await desk.state().catch(() => null);
{
  const lambda = new LambdaClient({ region: desk.region });
  const name = "zudocs-desk-api";
  const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  const env = { ...(current.Environment?.Variables ?? {}) };
  const epoch = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  if (dryRun) found(`would set STATE_EPOCH ${env.STATE_EPOCH} → ${epoch}`);
  else {
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, Environment: { Variables: { ...env, STATE_EPOCH: epoch } } }));
    for (let i = 0; i < 30; i += 1) {
      await sleep(2000);
      const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      if (c.LastUpdateStatus === "Successful") break;
      if (c.LastUpdateStatus === "Failed") throw new Error(`the function update failed: ${c.LastUpdateStatusReason}`);
    }
    did(`STATE_EPOCH ${env.STATE_EPOCH} → ${epoch} (CloudFormation will put the stack's value back on the next deploy; that is a new epoch too)`);
  }
}

// --- 8. every status row agrees ------------------------------------------------------------------------------------------
say("8. the fleet");
if (!dryRun) {
  // The epoch bump replaced every container: the first request to a cold one runs the boot sync and the golden set
  // and can pass the API's 30-second cap (a 503 once) — wait for a container that answers.
  const answering = () => desk.waitFor("the desk to answer after the epoch bump", async () => { const s = await desk.state(); return s?.host?.instanceId ? s : null; }, { timeoutMs: 180_000, everyMs: 5_000 });
  await answering();
  const sync = await desk.api("POST", "/presenter/sync");
  const after = await answering();
  const was = beforeEpoch?.host?.instanceId ? beforeEpoch.host.instanceId.slice(0, 12) : "unknown";
  found(`us-east: container ${after.host.instanceId.slice(0, 12)} (was ${was} before the epoch bump${after.host.instanceId === beforeEpoch?.host?.instanceId ? " — the SAME container answered: the bump did not replace it yet" : ""}) · sync ${sync.json.outcome ?? sync.status} · generation ${sync.json.generation ?? "?"}`);
  // The air-gapped host is optional (it may be down); eu-west joins it only when step 5 found its row stale — a
  // host that merely did not approve in time is still required, so its lag is reported here, not hidden.
  const optional = euWest.stale ? ["ap-southeast-1/airgap", EU] : ["ap-southeast-1/airgap"];
  if (noWait || promoted.length === 0) {
    const rows = fleetAgreement((await desk.state()).hosts, startGeneration, { optional });
    for (const r of rows.rows) say(`    ${r.hostId.padEnd(22)} #${r.generation} ${r.applyState ?? ""}${r.staged ? ` staged #${r.staged}` : ""}${r.stale ? " (stale row)" : ""}`);
    if (noWait) say(`reset: the zudocs side is done in ${Math.round((Date.now() - startedAt) / 1000)} s; not waited for the console (--no-wait) — the fleet agrees once the hosts take the fresh generation`);
    else say(`reset INCOMPLETE in ${Math.round((Date.now() - startedAt) / 1000)} s: the zudocs side is done, but nothing newer than #${startGeneration} was promoted in AirPrompter`);
    process.exit(noWait ? 0 : 1);
  }
  if (euWest.stale) found("eu-west's row was stale in step 5: optional here, and said so");
  if (euWest.late.length) found(`eu-west did not approve ${euWest.late.map((g) => `#${g}`).join(", ")} in time in step 5: required here, so a lag shows below`);
  // The target is the newest generation the pointer names now: a person may have promoted more than once (ending an
  // experiment and lifting a freeze are generations too), and every host must reach the last of them.
  let target = Math.max(promoted.at(-1), await currentGeneration());
  const agreement = await desk.waitFor(`the fleet to agree on a generation newer than #${startGeneration}`, async () => {
    target = Math.max(target, await currentGeneration());
    const pending = euWest.stale ? null : (await desk.approvals()).find((a) => a.hostId === EU && a.decision === "pending" && a.generation > startGeneration);
    if (pending) await approveOnEuWest(pending.generation);
    const a = fleetAgreement((await desk.state()).hosts, target, { optional });
    return a.agree ? a : null;
  }, { timeoutMs: 420_000, everyMs: 10_000 }).catch((error) => ({ agree: false, error: error.message }));
  const rows = fleetAgreement((await desk.state()).hosts, target, { optional });
  for (const r of rows.rows) say(`    ${r.hostId.padEnd(22)} #${r.generation} ${r.applyState ?? ""}${r.staged ? ` staged #${r.staged}` : ""}${r.stale ? " (stale row)" : ""}${optional.includes(r.hostId) && r.stale ? " (optional)" : ""}`);
  if (agreement.agree) did(`every reporting host is at #${target}${euWest.stale ? " (eu-west optional: its row was stale)" : ""}`);
  else say(`  ✗ ${agreement.error ?? "the fleet does not agree"}: ${rows.disagree.map((r) => `${r.hostId} #${r.generation}`).join(", ")}${euWest.late.length ? ` — eu-west's approval of ${euWest.late.map((g) => `#${g}`).join(", ")} ran out of time in step 5` : ""}`);
  say(`reset ${agreement.agree ? "complete" : "INCOMPLETE"} in ${Math.round((Date.now() - startedAt) / 1000)} s: #${startGeneration} → #${target}`);
  process.exit(agreement.agree ? 0 : 1);
} else say("dry run: nothing touched");
