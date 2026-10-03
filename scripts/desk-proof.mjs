#!/usr/bin/env node
/**
 * The desk, proved end to end from the owner's session: sign in as the proof user through the `proof` client
 * (password from ZUDOCS_PROOF_PASSWORD in the environment, never argv), read the deployed stacks' outputs, seed
 * the inbox, run one ticket through the API — the response must carry the rendered prompt version, the model's
 * answer from Bedrock, the SDK's observation (latency, tokens, usage source), the checks and the judge score —
 * file feedback, read the host's status row and the timeline, and see the tee's metrics in CloudWatch. With
 * `--expect-cap N` it instead proves the daily cap refuses visibly (HTTP 429, `daily_cap`, the count) — deploy
 * with `--context dailyRunCap=N` first, then redeploy without it. Prints ids, counts and verdicts, the reply's
 * first lines (what the desk shows), and never a token or a password. Exit 1 when a claim fails.
 *
 * @example
 * ```sh
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'        # from the owner's password store
 * npm run desk:proof                                          # a full run
 * npm run desk:proof -- --expect-cap 2                        # after `cdk deploy ZudocsDesk --context dailyRunCap=2`
 * ```
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { secretFromEnv } from "./lib/config.mjs";

const region = process.env.AWS_REGION ?? "us-east-1";
const args = process.argv.slice(2);
const expectCap = args.includes("--expect-cap") ? Number(args[args.indexOf("--expect-cap") + 1]) : null;
const proofEmail = process.env.ZUDOCS_PROOF_EMAIL ?? "proof@zudocs.com";

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

const cfn = new CloudFormationClient({ region });
const outputsOf = async (stackName) => Object.fromEntries((await cfn.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]));
const site = await outputsOf("ZudocsSite");
const desk = await outputsOf("ZudocsDesk");
console.log(`stacks: pool ${site.UserPoolId} · proof client ${site.ProofClientId.slice(0, 6)}… · api ${desk.ApiUrl} · desk ${desk.DeskUrl}`);

const cognito = new CognitoIdentityProviderClient({ region });
const auth = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: site.UserPoolId, ClientId: site.ProofClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: proofEmail, PASSWORD: password } }));
const idToken = auth.AuthenticationResult?.IdToken;
if (!idToken) {
  console.log(`sign-in as ${proofEmail} did not yield tokens (challenge: ${auth.ChallengeName ?? "none"})`);
  process.exit(1);
}
ok(`signed in as ${proofEmail} through the proof client (id token ${idToken.length} chars, expires in ${auth.AuthenticationResult.ExpiresIn}s)`);

const api = async (method, path, body) => {
  const res = await fetch(`${desk.ApiUrl}${path}`, { method, headers: { authorization: `Bearer ${idToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { text: text.slice(0, 300) }; }
  return { status: res.status, json };
};

// Unauthenticated and wrongly authenticated requests never reach the function.
const anon = await fetch(`${desk.ApiUrl}/tickets`);
(anon.status === 401 ? ok : fail)(`no token → ${anon.status} from the authorizer`);
const bad = await fetch(`${desk.ApiUrl}/tickets`, { headers: { authorization: "Bearer not.a.jwt" } });
(bad.status === 401 ? ok : fail)(`a bad token → ${bad.status} from the authorizer`);

if (expectCap !== null) {
  const state = await api("GET", "/state");
  console.log(`cap: ${JSON.stringify(state.json.cap)}`);
  if (state.json.cap?.cap !== expectCap) fail(`the deployed cap is ${state.json.cap?.cap}, not ${expectCap} — deploy with --context dailyRunCap=${expectCap} first`);
  const { tickets } = (await api("GET", "/tickets")).json;
  let refused = null;
  for (let i = 0; i <= expectCap && !refused; i += 1) {
    const r = await api("POST", `/tickets/${tickets[i % tickets.length].ticketId}/run`);
    console.log(`  run ${i + 1}: ${r.status}${r.status === 429 ? ` ${r.json.error} — ${r.json.message}` : ` (cap used ${r.json.cap?.used ?? "?"})`}`);
    if (r.status === 429) refused = r.json;
  }
  if (refused && refused.error === "daily_cap" && refused.used >= expectCap && /Nothing was simulated/.test(refused.message)) ok(`the cap refused visibly: 429 daily_cap, ${refused.used}/${refused.cap} on ${refused.day}`);
  else fail("no visible refusal at the cap");
  console.log(failures === 0 ? "cap proof ok" : `cap proof failed: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

let state = await api("GET", "/state");
if (state.status === 503) {
  console.log(`host unavailable on the first request (${state.json.code}: ${state.json.message}); trying once more in 5 s`);
  await new Promise((r) => setTimeout(r, 5000));
  state = await api("GET", "/state");
}
if (state.status !== 200) {
  fail(`/state answered ${state.status}: ${JSON.stringify(state.json).slice(0, 300)}`);
  console.log(`proof failed: ${failures} problem(s)`);
  process.exit(1);
}
const host = state.json.host;
console.log(`host ${host.hostId} · ${host.sdk} · instance ${host.instanceId} · generation ${host.status.generation} · ${host.status.applyState} · ${host.status.storageProtection} · policy ${host.status.applyPolicy.effective} (${host.status.applyPolicy.source}) · models ${JSON.stringify(host.models)} · sources ${JSON.stringify(host.status.variables.sources)} · healthz ${host.healthz.status} · state dir ${host.stateDir}`);
(host.status.storageProtection === "kms" ? ok : fail)(`the store key is wrapped by KMS (${host.status.storageProtection})`);
(host.status.generation >= 1 && host.status.applyState === "active" ? ok : fail)(`a verified release is active (generation ${host.status.generation}, ${host.status.applyState})`);
(host.status.variables.sources.includes("customer_tier") ? ok : fail)("customer_tier is sourced from the desk's own table");
(host.stateDir.startsWith("/tmp/airprompter/") ? ok : fail)(`the state directory is under /tmp (${host.stateDir})`);

const seeded = await api("POST", "/presenter/seed");
(seeded.status === 200 ? ok : fail)(`seeded ${seeded.json.tickets} tickets and ${seeded.json.customers} customers`);
const { tickets } = (await api("GET", "/tickets")).json;
const ticket = tickets.find((t) => t.ticketId === (process.env.ZUDOCS_PROOF_TICKET ?? "T-1041")) ?? tickets[0];
console.log(`running ${ticket.ticketId} (${ticket.customer.name}, ${ticket.customer.tier})…`);
const started = Date.now();
const run = await api("POST", `/tickets/${ticket.ticketId}/run`);
console.log(`  → ${run.status} in ${Date.now() - started} ms`);
if (run.status !== 200 && run.status !== 502) {
  fail(`the run answered ${run.status}: ${JSON.stringify(run.json).slice(0, 400)}`);
} else {
  const record = run.json.run;
  console.log(`run ${record.runId} · ok=${record.ok} · generation ${record.generation} · ${record.durationMs} ms · cap ${run.json.cap.used}/${run.json.cap.cap}`);
  for (const step of record.steps) {
    const o = step.observation;
    console.log(`  ${step.step}: ${step.tag} ${step.versionId} · release #${step.generation} · arm ${step.arm} · ${step.model} · ${o ? `${o.status} ${o.latencyMs} ms · tokens ${JSON.stringify(o.tokens ?? {})} · usage ${o.usageSource}${o.errorClass ? ` · ${o.errorClass}` : ""}` : "no observation"} · checks ${step.checks.map((c) => `${c.name}:${c.verdict}`).join(",") || "none"} · cost ${step.costUsd ?? "—"}${step.judge ? ` · judge ${step.judge.score} (${step.judge.taskPass}/${step.judge.taskPass + step.judge.taskFail}, on ${step.judge.model})` : ""}${step.error ? ` · ERROR ${step.error.name}: ${step.error.message}` : ""}`);
    if (step.rendered) console.log(`    variables: ${step.rendered.variables.map((v) => `${v.name}=${v.origin}${v.fenced ? "(fenced)" : ""}`).join(" ")} · inference ${JSON.stringify(step.rendered.inference)}`);
  }
  const reply = record.steps.find((s) => s.step === "reply");
  const triage = record.steps.find((s) => s.step === "triage");
  const expectedGeneration = process.env.ZUDOCS_EXPECT_GENERATION ? Number(process.env.ZUDOCS_EXPECT_GENERATION) : null;
  (reply?.versionId && /^rev-\d+$/.test(reply.versionId) && reply.generation >= 1 && (expectedGeneration === null || reply.generation === expectedGeneration) ? ok : fail)(`the reply rendered prompt version ${reply?.versionId} at release #${reply?.generation}${expectedGeneration !== null ? ` (expected #${expectedGeneration})` : ""}`);
  // The release's model is the catalogue's: Luna is the intended one, Nova 2 Lite the one pinned while the account's gate is up (docs/PROMPTS.md).
  (reply?.model && ["openai.gpt-5-6-luna", "amazon.nova-2-lite"].includes(reply.model) ? ok : fail)(`the reply's model is the release's (${reply?.model})`);
  (reply?.output && reply.observation?.status === "ok" ? ok : fail)(`${reply?.model ?? "the model"} answered through Bedrock: ${reply?.observation?.status ?? "no observation"}${reply?.error ? ` — ${reply.error.message}` : ""}`);
  (triage?.output && triage.observation?.status === "ok" ? ok : fail)(`Nova Micro answered through Bedrock: ${triage?.observation?.status ?? "no observation"}${triage?.error ? ` — ${triage.error.message}` : ""}`);
  (record.triage?.category ? ok : fail)(`triage read as ${JSON.stringify(record.triage)}`);
  (reply?.observation?.usageSource === "reported" ? ok : fail)(`usage reported by the provider (${reply?.observation?.usageSource})`);
  (reply?.checks.length === 3 ? ok : fail)(`three declared checks ran on the reply (${reply?.checks.map((c) => c.verdict).join("/")})`);
  (reply?.judge && reply.judge.score !== null ? ok : fail)(`the judge scored the reply: ${reply?.judge ? `${reply.judge.score}` : "no judge"}`);
  (reply?.rendered?.variables.some((v) => v.name === "customer_tier" && v.origin === "your_source" && v.value === ticket.customer.tier) ? ok : fail)("customer_tier came from the desk's source at render time");
  (reply?.rendered?.variables.some((v) => v.name === "ticket" && v.fenced) ? ok : fail)("the ticket is fenced as end-user text");
  if (reply?.output) console.log(`reply (first 400 chars):\n${reply.output.slice(0, 400).split("\n").map((l) => "    " + l).join("\n")}`);
  const feedback = await api("POST", `/runs/${record.runId}/feedback`, { step: "reply", signals: { thumbs: "up", accepted: true } });
  (feedback.status === 200 && feedback.json.filed ? ok : fail)(`feedback filed through ap.feedback: ${feedback.status} ${JSON.stringify(feedback.json)}`);
}

const after = await api("GET", "/state");
const row = after.json.hosts.find((h) => h.hostId === host.hostId);
// The row is written after the run; a promotion that landed on this very invocation moves it past what /state said before.
(row && row.status.generation >= host.status.generation ? ok : fail)(`the status table holds this host's row (generation ${row?.status?.generation}, written ${row?.writtenAt}, healthz ${row?.healthz?.status}, heartbeat ${row?.status?.heartbeat?.lastAt ?? "none"})`);
const events = (await api("GET", "/events")).json.events;
const kinds = events.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
(events.some((e) => e.kind === "ticket_run") && events.some((e) => e.kind === "host_started") ? ok : fail)(`the events table fills: ${JSON.stringify(kinds)}`);

// CloudWatch: the tee's metrics (EMF lines are extracted within a few minutes of the log write).
const cw = new CloudWatchClient({ region });
let metrics = [];
for (let attempt = 0; attempt < 12 && metrics.length === 0; attempt += 1) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 15_000));
  metrics = (await cw.send(new ListMetricsCommand({ Namespace: "Zudocs/Desk", RecentlyActive: "PT3H" }))).Metrics ?? [];
}
if (metrics.length > 0) {
  const names = [...new Set(metrics.map((m) => m.MetricName))].sort();
  const dimensionSets = [...new Set(metrics.map((m) => (m.Dimensions ?? []).map((d) => d.Name).sort().join(",")))];
  ok(`CloudWatch metrics in Zudocs/Desk: ${names.join(", ")} · dimension sets ${JSON.stringify(dimensionSets)} · ${metrics.length} series`);
  const tags = [...new Set(metrics.flatMap((m) => (m.Dimensions ?? []).filter((d) => d.Name === "tag").map((d) => d.Value)))];
  console.log(`  tags seen: ${tags.join(", ")}`);
} else fail("no metrics in Zudocs/Desk yet (the tee emits only when AirPrompter accepted the segment; check the function's log for telemetry_flushed)");

console.log(failures === 0 ? "desk proof ok" : `desk proof failed: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
