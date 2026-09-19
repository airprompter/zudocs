#!/usr/bin/env node
/**
 * Reset means advance. After a session the fleet holds whatever the beats left: an experiment, a freeze, a pinned
 * policy, a forced downgrade, a queue of nudges, a cut wire, a day's records. Nothing is restored — generations are
 * monotonic, a tightened pin loosens only on the host, a rollback holds a host back until something newer lands —
 * so the reset moves forward: it ends the experiments, lifts the freeze, puts the us-east host's policy back to
 * `auto` (an operator's act through the SDK; the eu-west daemon's policy is its unit's flag, which no drill changes),
 * waits for a replay in flight, purges the nudge queue (then waits the minute SQS asks for before the next message),
 * restores the wire, promotes TWO fresh canonical generations (the
 * escalation summary's output cap +1 and +2: real changes, so each seals to a new digest) and approves each on
 * eu-west so every store holds two releases (a rollback needs a previous one), nudges the fleet after each, clears
 * the desk's records and re-seeds the inbox, resets the day counter, bumps the desk Lambda's `STATE_EPOCH` (new
 * containers start from an empty store), and ends by checking that every status row agrees on the generation.
 * Idempotent: every step reads before it writes and says what it did or found done. Needs the session token
 * (`AIRPROMPTER_SESSION_TOKEN`), the proof password (`ZUDOCS_PROOF_PASSWORD`) and the owner's AWS profile.
 *
 * @example
 * ```sh
 * eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'
 * npm run demo:reset                 # ~4 minutes: two generations, two approvals, the fleet agreeing
 * npm run demo:reset -- --dry-run    # say what would be done; touch nothing
 * ```
 */
import { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { PurgeQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { readConfig, secretFromEnv } from "./lib/config.mjs";
import { createConsole } from "./lib/console.mjs";
import { canonicalPins, fleetAgreement, releaseLine } from "./lib/demo.mjs";
import { connectDesk, sleep, stackOutputs } from "./lib/desk.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const say = (line) => console.log(line);
const did = (line) => say(`  ✓ ${line}`);
const found = (line) => say(`  · ${line}`);
const startedAt = Date.now();

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
const con = createConsole({ config, token, log: (e) => e.event === "platform_5xx_retry" && found(`the platform answered ${e.status} on ${e.method} ${e.path}; retried once`) });
const desk = await connectDesk();
const fleetRegion = process.env.ZUDOCS_FLEET_REGION ?? "ap-southeast-1";
const EU = "eu-west-1/ec2";

// --- 1. experiments end ------------------------------------------------------------------------------------------
say("1. experiments");
{
  const live = (await con.experiments.list({ environment: ENV })).filter((e) => ["running", "held", "complete"].includes(e.status ?? "running"));
  if (live.length === 0) found("no live experiment");
  for (const e of live) {
    if (dryRun) { found(`would end ${e.experimentId} (${e.tag ?? "*"})`); continue; }
    const out = await con.experiments.weights({ environment: ENV, experimentId: e.experimentId, action: "end", notes: "Zudocs reset: rolled back to the control" });
    did(`ended ${e.experimentId} (${e.tag ?? "*"}): ${out.experiment.status}; generation ${out.pointer.generation}`);
  }
}

// --- 2. unfreeze ---------------------------------------------------------------------------------------------------
say("2. freeze");
{
  const p = await con.pointer(ENV);
  if (!p.frozen) found("not frozen");
  else if (dryRun) found("would unfreeze");
  else { const { pointer } = await con.freeze({ environment: ENV, frozen: false, notes: "Zudocs reset: unfrozen" }); did(`unfrozen (generation ${pointer.generation})`); }
}

// --- 3. the us-east host's policy (the one a drill can loosen or tighten) --------------------------------------------
say("3. policies");
{
  const state = await desk.state();
  const east = state.host.status?.applyPolicy;
  if (east?.effective === "auto") found(`us-east: auto (${east.source})`);
  else if (dryRun) found(`us-east: would set auto (now ${east?.effective} ${east?.source})`);
  else { const r = await desk.api("POST", "/presenter/policy", { value: "auto" }); did(`us-east: ${r.json.message ?? JSON.stringify(r.json).slice(0, 200)}`); }
  found("eu-west: the daemon runs --apply-policy unlock_required (its unit's flag); no drill changes it, nothing to put back");
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

// --- 5. two fresh canonical generations, each approved on eu-west ------------------------------------------------------
say("5. two fresh canonical generations");
const promoted = [];
const approveOnEuWest = async (generation) => {
  const euRow = await desk.hostRow(EU);
  if (!euRow) { found("eu-west has no status row; nothing to approve"); return null; }
  if (Date.now() - Date.parse(euRow.writtenAt) > 15 * 60_000) { found(`eu-west's row is ${Math.round((Date.now() - Date.parse(euRow.writtenAt)) / 60_000)} min old (the host is down or replacing itself); not waiting for its approval`); return null; }
  // Either the pending row appears, or the host is already at the generation (an operator's unlock, a window, or a
  // row settled by the worker): both are "done".
  const found_ = await desk.waitFor(`eu-west to stage #${generation}`, async () => {
    const row = (await desk.approvals()).find((a) => a.hostId === EU && a.generation === generation);
    if (row?.decision === "pending") return { pending: row };
    if (row && ["approved", "activated", "superseded"].includes(row.decision)) return { settled: row };
    const host = await desk.hostRow(EU);
    if (Number(host?.status?.generation) >= generation) return { live: host };
    return null;
  }, { timeoutMs: 180_000 });
  if (found_.live) { found(`eu-west already serves #${found_.live.status.generation}`); return null; }
  if (found_.settled) { found(`eu-west's row for #${generation} is already ${found_.settled.decision}`); return found_.settled; }
  const pending = found_.pending;
  const decided = await desk.api("POST", `/approvals/${encodeURIComponent(pending.approvalId)}/approve`, {});
  if (decided.status !== 200) { say(`  ✗ approve #${generation} on eu-west refused: HTTP ${decided.status} ${decided.json.error ?? ""} ${decided.json.message ?? ""}`); return null; }
  did(`approved #${generation} on eu-west (${decided.json.already ? "already decided" : "decided now"})`);
  const activated = await desk.waitFor(`eu-west to activate #${generation}`, async () => (await desk.approvals()).find((a) => a.approvalId === pending.approvalId && ["activated", "superseded"].includes(a.decision)) ?? null, { timeoutMs: 120_000 });
  did(`eu-west ${activated.decision} #${generation} at ${activated.activatedAt ?? activated.updatedAt}`);
  return activated;
};
for (const step of [1, 2]) {
  if (dryRun) { found(`would promote canonical generation ${step} of 2 (summary cap +${step})`); continue; }
  const v = await con.newVersion({ tag: "support.escalate.summary", inference: (current) => ({ ...current, maxOutputTokens: Number(current.maxOutputTokens ?? 400) + 1 }), message: `Reset means advance: the summary's cap +1 (${step}/2)` });
  const pins = canonicalPins(config, { "support.escalate.summary": { versionId: v.versionId } });
  const sealed = await con.seal({ environment: ENV, pins, notes: `Zudocs reset ${step}/2: a fresh canonical generation (summary cap ${v.inference?.maxOutputTokens})` });
  if (sealed.blocked) { say(`  ✗ the seal refused the canonical pins: ${JSON.stringify(sealed.blocked).slice(0, 400)}`); process.exit(1); }
  const pointer = await con.promote({ environment: ENV, releaseDigest: sealed.release.releaseDigest, notes: `Zudocs reset ${step}/2` });
  did(`promoted ${releaseLine(pointer.generation, pointer.releaseDigest)} (summary ${v.versionId}, cap ${v.inference?.maxOutputTokens})`);
  promoted.push(pointer.generation);
  const nudged = await desk.api("POST", "/presenter/nudge");
  found(nudged.status === 202 ? `nudged the fleet (${nudged.json.messageId})` : `nudge: ${nudged.json.message ?? nudged.status}`);
  await desk.api("POST", "/presenter/sync");
  await approveOnEuWest(pointer.generation);
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
  const target = promoted[promoted.length - 1];
  // The epoch bump replaced every container: the first request to a cold one runs the boot sync and the golden set
  // and can pass the API's 30-second cap (a 503 once, DEMO.md › Honest notes) — wait for a container that answers.
  const answering = () => desk.waitFor("the desk to answer after the epoch bump", async () => { const s = await desk.state(); return s?.host?.instanceId ? s : null; }, { timeoutMs: 180_000, everyMs: 5_000 });
  const before = await answering();
  const sync = await desk.api("POST", "/presenter/sync");
  const after = await answering();
  found(`us-east: container ${after.host.instanceId.slice(0, 12)} (was ${before.host.instanceId.slice(0, 12)}) · sync ${sync.json.outcome ?? sync.status} · generation ${sync.json.generation ?? "?"}`);
  const agreement = await desk.waitFor(`the fleet to agree on #${target}`, async () => {
    const a = fleetAgreement((await desk.state()).hosts, target);
    return a.agree ? a : null;
  }, { timeoutMs: 420_000, everyMs: 10_000 }).catch((error) => ({ agree: false, error: error.message, rows: fleetAgreement([], target).rows }));
  const rows = fleetAgreement((await desk.state()).hosts, target);
  for (const r of rows.rows) say(`    ${r.hostId.padEnd(22)} #${r.generation} ${r.applyState ?? ""}${r.staged ? ` staged #${r.staged}` : ""}${r.stale ? " (stale row)" : ""}`);
  if (agreement.agree) did(`every reporting host is at #${target}`);
  else say(`  ✗ ${agreement.error ?? "the fleet does not agree"}: ${rows.disagree.map((r) => `${r.hostId} #${r.generation}`).join(", ")}`);
  say(`reset ${agreement.agree ? "complete" : "INCOMPLETE"} in ${Math.round((Date.now() - startedAt) / 1000)} s: generations ${promoted.join(" → ")}`);
  process.exit(agreement.agree ? 0 : 1);
} else say("dry run: nothing touched");
