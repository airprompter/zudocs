#!/usr/bin/env node
/**
 * The eu-west host, proved from the owner's session: the host's row in the status table says what the plan
 * promised (a daemon host, `file_key` shown, policy `unlock_required` pinned on the host, both workers attached), the
 * operator's CLI on the host answers through Session Manager's Run Command (`status`, and `doctor` warning about
 * `file_key`), and — with the flags — a queued ticket runs there through the daemon, a staged release is approved
 * from the desk and activates, an `unlock` or a `rollback` runs from the host's shell, and the wire is cut and
 * comes back. A fresh (or replaced) host serves nothing until its first release is approved, so its workers are not
 * attached and `doctor` reports no active release: the proof says so and expects it, and `--approve` is the way to
 * a serving host. Prints ids, counts and verdicts; never a key (the CLI's output is printed as the CLI printed it,
 * and the CLI never prints one). Exit 1 when a claim fails.
 *
 * @example
 * ```sh
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'         # the proof user's password, from the owner's store
 * npm run eu:proof -- --approve                               # a fresh host: approve its first release, watch it serve
 * npm run eu:proof                                            # the row, status and doctor on a serving host
 * npm run eu:proof -- --enqueue T-1041                        # run one ticket on eu-west now and read the record
 * npm run eu:proof -- --cli unlock                            # or --cli rollback, --cli "policy show"
 * npm run eu:proof -- --wire                                  # cut, watch sync_failing, restore, watch it recover
 * ```
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { secretFromEnv } from "./lib/config.mjs";

const siteRegion = process.env.AWS_REGION ?? "us-east-1";
const hostRegion = process.env.ZUDOCS_HOST_REGION ?? "eu-west-1";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const proofEmail = process.env.ZUDOCS_PROOF_EMAIL ?? "proof@zudocs.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures += 1; console.log(`  ✗ ${m}`); };

let password;
try {
  password = secretFromEnv("ZUDOCS_PROOF_PASSWORD", "the proof user's password (scripts/cognito-users.sh proof)");
} catch (error) {
  console.log(error.message);
  process.exit(2);
}

const outputsOf = async (region, stackName) => Object.fromEntries((await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }))).Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]));
const site = await outputsOf(siteRegion, "ZudocsSite");
const desk = await outputsOf(siteRegion, "ZudocsDesk");
const host = await outputsOf(hostRegion, "ZudocsSharedHost");
console.log(`stacks: api ${desk.ApiUrl} · host ${host.HostId} · instance ${host.InstanceId} · group ${host.SecurityGroupId} · wire ${host.WireFunctionName} · logs ${host.LogGroupName}`);

const cognito = new CognitoIdentityProviderClient({ region: siteRegion });
const auth = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: site.UserPoolId, ClientId: site.ProofClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: proofEmail, PASSWORD: password } }));
const idToken = auth.AuthenticationResult?.IdToken;
if (!idToken) {
  console.log(`sign-in as ${proofEmail} did not yield tokens (challenge: ${auth.ChallengeName ?? "none"})`);
  process.exit(1);
}
ok(`signed in as ${proofEmail} through the proof client`);
const api = async (method, path, body) => {
  const res = await fetch(`${desk.ApiUrl}${path}`, { method, headers: { authorization: `Bearer ${idToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { text: text.slice(0, 300) }; }
  return { status: res.status, json };
};
const hostRow = async () => (await api("GET", "/state")).json.hosts?.find((h) => h.hostId === host.HostId) ?? null;
const describeRow = (row) => `generation ${row.status.generation} · ${row.status.applyState}${row.status.stagedGeneration ? ` · staged #${row.status.stagedGeneration}` : ""} · ${row.status.storageProtection} · policy ${row.status.applyPolicy?.effective} (${row.status.applyPolicy?.source}) · sync ${row.status.lastSyncOutcome} (${row.status.consecutiveSyncFailures} failures) · healthz ${row.healthz.status}${row.healthz.reasons?.length ? ` [${row.healthz.reasons.join(",")}]` : ""} · written ${row.writtenAt}`;

// --- The row -------------------------------------------------------------------------------------------------------
const row = await hostRow();
if (!row) {
  fail(`no status row for ${host.HostId} yet (the worker writes it 30 s after it attaches; the first boot takes ~10 minutes)`);
  console.log(`eu-host proof failed: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`row: ${describeRow(row)}`);
console.log(`     sdk ${row.sdk} · node worker ${row.worker ? `${row.worker.sdk} ${row.worker.attached ? "attached" : "detached"} ${row.worker.tickets} tickets` : "missing"} · python ${row.python ? `${row.python.sdk} ${row.python.attached ? "attached" : "detached"} ${row.python.runs} runs` : "missing"} · ec2 ${row.ec2?.instanceId ?? "?"}`);
(row.kind === "daemon" ? ok : fail)(`the host reports as a daemon host (${row.kind})`);
(row.status.storageProtection === "file_key" ? ok : fail)(`the store key protection is shown honestly: ${row.status.storageProtection}`);
(row.status.applyPolicy?.effective === "unlock_required" ? ok : fail)(`the apply policy is unlock_required on the host (${row.status.applyPolicy?.effective}, ${row.status.applyPolicy?.source})`);
// A fresh host (or a replaced one) serves nothing until the desk approves its first release: the SDKs are not attached
// yet and doctor reports no active release. Those checks wait for a serving host; `--approve` is the way there.
const serving = Number(row.status.generation) > 0;
if (serving) {
  (row.worker?.attached && row.worker.source === "daemon" ? ok : fail)("the Node worker is attached to the daemon");
  (row.python?.attached ? ok : fail)(`the Python worker is attached to the same daemon (${row.python?.sdk ?? "not reporting"})`);
} else {
  console.log(`  · the host serves nothing yet (generation 0${row.status.stagedGeneration ? `, staged #${row.status.stagedGeneration}` : ""}): the workers attach after the first approval — run with --approve`);
  (row.worker && !row.worker.attached ? ok : fail)(`the Node worker reports itself waiting (${row.worker?.reasons?.join(",") ?? "no worker part"})`);
}
(row.ec2?.instanceId === host.InstanceId ? ok : fail)(`the row names the stack's instance (${row.ec2?.instanceId})`);
(Date.now() - Date.parse(row.writtenAt) < 120_000 ? ok : fail)(`the row is fresh (written ${Math.round((Date.now() - Date.parse(row.writtenAt)) / 1000)} s ago)`);

// --- The CLI on the host, through Run Command ------------------------------------------------------------------------
const ssm = new SSMClient({ region: hostRegion });
async function onHost(command, timeoutSeconds = 90) {
  const sent = await ssm.send(new SendCommandCommand({ InstanceIds: [host.InstanceId], DocumentName: "AWS-RunShellScript", Parameters: { commands: [command], executionTimeout: [String(timeoutSeconds)] }, Comment: "zudocs eu-host proof" }));
  const id = sent.Command.CommandId;
  for (let i = 0; i < timeoutSeconds + 15; i += 1) {
    await sleep(2000);
    try {
      const out = await ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: host.InstanceId }));
      if (["Success", "Failed", "TimedOut", "Cancelled"].includes(out.Status)) return { status: out.Status, stdout: out.StandardOutputContent ?? "", stderr: out.StandardErrorContent ?? "" };
    } catch (error) {
      if (error.name !== "InvocationDoesNotExist") throw error;
    }
  }
  return { status: "TimedOut", stdout: "", stderr: "" };
}
const show = (label, result) => {
  console.log(`--- ${label} (${result.status})`);
  for (const line of `${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.trim().split("\n")) console.log(`    ${line}`);
};

const status = await onHost("zudocs-cli status --json");
show("airprompter status --json (on the host, via the daemon)", status);
let statusDoc = null;
try { statusDoc = JSON.parse(status.stdout); } catch { /* shown above */ }
(statusDoc && Number(statusDoc.generation ?? statusDoc.active?.generation) === Number(row.status.generation) ? ok : fail)(`airprompter status on the host agrees with the row (generation ${statusDoc?.generation ?? statusDoc?.active?.generation ?? "?"} vs ${row.status.generation})`);

const doctor = await onHost("zudocs-cli doctor --json", 120);
show("airprompter doctor --json (on the host)", doctor);
let doctorDoc = null;
try { doctorDoc = JSON.parse(doctor.stdout); } catch { /* shown above */ }
const checks = doctorDoc?.checks ?? [];
const keyCheck = checks.find((c) => c.name === "key_protection");
(keyCheck?.level === "warn" && /file_key/.test(keyCheck.detail) ? ok : fail)(`doctor warns about the key protection: ${keyCheck ? `${keyCheck.level} — ${keyCheck.detail}` : "no key_protection check in the output"}`);
const expectedFails = serving ? [] : ["active_release", "daemon"];
const unexpected = checks.filter((c) => c.level === "fail" && !expectedFails.includes(c.name));
// The checks a host always has (lease and last_upload appear only once a release is active and a segment was acked).
const named = ["source", "root", "store", "key_protection", "policy_pin", "spool", "daemon"].filter((n) => !checks.some((c) => c.name === n));
(named.length === 0 && unexpected.length === 0 ? ok : fail)(`doctor ran ${checks.length} checks with no failure${serving ? "" : " beyond the two a host with nothing active reports"}${named.length ? ` — missing ${named.join(", ")}` : ""} (${checks.map((c) => `${c.name}:${c.level}`).join(" ")})`);

// --- Optional drills --------------------------------------------------------------------------------------------------
if (flag("--approve")) {
  const { approvals } = (await api("GET", "/approvals")).json;
  const pending = approvals.filter((a) => a.hostId === host.HostId && a.decision === "pending");
  if (pending.length === 0) fail("nothing is staged for this host — promote a release first (the daemon stages it within 30 s)");
  for (const a of pending) {
    const decided = await api("POST", `/approvals/${a.approvalId}/approve`);
    console.log(`approve ${a.approvalId}: ${decided.status} ${decided.json.message ?? ""}`);
    (decided.status === 200 && decided.json.already === false ? ok : fail)(`approved release #${a.generation} on ${a.hostId} once`);
    const again = await api("POST", `/approvals/${a.approvalId}/approve`);
    (again.status === 200 && again.json.already === true ? ok : fail)(`a second approve is not a second decision (already=${again.json.already})`);
    let settled = null;
    for (let i = 0; i < 30 && !settled; i += 1) {
      await sleep(3000);
      const current = (await api("GET", "/approvals")).json.approvals.find((x) => x.approvalId === a.approvalId);
      if (current && current.decision !== "approved") settled = current;
    }
    (settled?.decision === "activated" ? ok : fail)(`the host activated it: ${settled ? `${settled.decision} at ${settled.activatedAt ?? "?"} — ${settled.outcome}` : "no settlement within 90 s"}`);
    let after = null;
    for (let i = 0; i < 14 && !(after && after.status.generation === a.generation && after.status.applyState === "active"); i += 1) {
      if (i > 0) await sleep(3000);
      after = await hostRow();
    }
    (after && after.status.generation === a.generation && after.status.applyState === "active" ? ok : fail)(`the host card flipped: ${after ? describeRow(after) : "no row"}`);
    let attached = after?.worker?.attached ? after : null;
    for (let i = 0; i < 12 && !attached; i += 1) {
      await sleep(5000);
      const current = await hostRow();
      if (current?.worker?.attached) attached = current;
    }
    (attached ? ok : fail)(`the Node worker attached once the host served (${attached?.worker?.sdk ?? "not within a minute"})`);
    const events = (await api("GET", "/events")).json.events.filter((e) => e.approvalId === a.approvalId);
    console.log(`  timeline for ${a.approvalId}: ${events.map((e) => `${e.at.slice(11, 19)} ${e.host} ${e.kind}`).join(" · ")}`);
  }
}

if (value("--enqueue")) {
  const ticketId = value("--enqueue");
  const since = new Date().toISOString();
  const queued = await api("POST", "/presenter/enqueue", { ticketId, host: host.HostId });
  console.log(`enqueue ${ticketId} → ${queued.status} ${queued.json.message ?? JSON.stringify(queued.json)}`);
  (queued.status === 202 ? ok : fail)("the ticket is on the host's queue");
  let event = null;
  for (let i = 0; i < 40 && !event; i += 1) {
    await sleep(3000);
    event = (await api("GET", `/events?since=${encodeURIComponent(since)}`)).json.events.find((e) => e.kind === "ticket_run" && e.host === host.HostId && e.ticketId === ticketId);
  }
  if (!event) fail("no ticket_run event from the host within two minutes");
  else {
    ok(`the host ran it: ${event.versionId} on ${event.model} · ok=${event.ok} · ${event.latencyMs} ms · by ${event.by}`);
    const run = (await api("GET", `/tickets/${ticketId}`)).json.runs.find((r) => r.runId === event.runId);
    for (const step of run?.steps ?? []) console.log(`  ${step.step}: ${step.tag} ${step.versionId} · release #${step.generation} · ${step.model} · ${step.observation ? `${step.observation.status} ${step.observation.latencyMs} ms · tokens ${JSON.stringify(step.observation.tokens ?? {})} · usage ${step.observation.usageSource}` : "no observation"} · checks ${step.checks.map((c) => `${c.name}:${c.verdict}`).join(",") || "none"}${step.judge ? ` · judge ${step.judge.score}` : ""}${step.error ? ` · ERROR ${step.error.name}: ${step.error.message}` : ""}`);
    (run?.host === host.HostId && run.ok ? ok : fail)(`the record is the host's and every step answered (host ${run?.host}, ok ${run?.ok})`);
  }
}

if (value("--cli")) {
  const command = value("--cli");
  const result = await onHost(`zudocs-cli ${command} --json`, 60);
  show(`airprompter ${command} --json (on the host)`, result);
  (result.status === "Success" ? ok : fail)(`airprompter ${command} answered on the host`);
  await sleep(35_000);
  const after = await hostRow();
  console.log(`row after: ${after ? describeRow(after) : "no row"}`);
}

if (flag("--wire")) {
  const cut = await api("POST", "/presenter/cut_wire");
  console.log(`cut → ${cut.status} ${cut.json.message ?? JSON.stringify(cut.json)}`);
  (cut.status === 200 && cut.json.state === "cut" ? ok : fail)(`the wire is cut (restore by ${cut.json.restoreBy})`);
  let degraded = null;
  const started = Date.now();
  for (let i = 0; i < 60 && !degraded; i += 1) {
    await sleep(5000);
    const current = await hostRow();
    if (current && current.healthz.status !== "ok" && (current.healthz.reasons ?? []).includes("sync_failing")) degraded = current;
  }
  (degraded ? ok : fail)(degraded ? `the host reported sync_failing ${Math.round((Date.now() - started) / 1000)} s after the cut: ${describeRow(degraded)}` : "the host never reported sync_failing within five minutes");
  const restore = await api("POST", "/presenter/restore_wire");
  console.log(`restore → ${restore.status} ${restore.json.message ?? JSON.stringify(restore.json)}`);
  (restore.status === 200 && restore.json.state === "connected" ? ok : fail)("the wire is back");
  // Recovered = the sync is back (no sync_failing, zero failures in a row); other degraded reasons the host may carry
  // (a forced downgrade from the rollback drill — sticky until the store is replaced, SDK #45) are not the wire's.
  let recovered = null;
  for (let i = 0; i < 36 && !recovered; i += 1) {
    await sleep(5000);
    const current = await hostRow();
    if (current && !(current.healthz.reasons ?? []).includes("sync_failing") && Number(current.status.consecutiveSyncFailures) === 0 && current.status.lastSyncOutcome !== "unavailable") recovered = current;
  }
  (recovered ? ok : fail)(recovered ? `the host's sync recovered: ${describeRow(recovered)}` : "the host still reported sync_failing three minutes after the restore");
}

console.log(failures === 0 ? "eu-host proof ok" : `eu-host proof failed: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
