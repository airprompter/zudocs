/**
 * Phase 6 units: the hosted run record over a fake managed client and a fake compatible endpoint (the stream's
 * deltas with their offsets, the feedback, the compat request beside the catalogue's sealed inference, a refusal
 * recorded in the route's words and never retried); the host CLI's allowlist, its JSON-line reading and its
 * Run Command polling over fake ports; the per-arm fold with the stickiness table; and the handler's new paths —
 * a frozen host refuses a run inside the invoke (after its sync pass — the fake's invoke is what freezes the host)
 * before the cap is taken, the same inside a replay job, `host_cli` refuses anything off the allowlist and hands
 * itself a job whose answer lands on the timeline (a Run Command that cannot be sent lands as a Failed row), an
 * approval the host has moved past answers `409 approval_stale`, a start that fails with SDK #52's fresh-store
 * signature is retried once, `policy` goes through
 * `setApplyPolicy`, `golden` reports counts only, `reset` clears and re-seeds, `/arms` folds the desk's own records,
 * `/state` and `/approvals` answer after a sync pass, and an approval row carries the ramp plan this host read.
 *
 * @example
 * ```sh
 * npx tsx --test test/phase6.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { foldArms } from "../src/arms.js";
import { FROZEN_REASON, approvalStaleness, createHandler, frozenOf, summariseCli } from "../src/handler.js";
import { HOST_CLI_COMMANDS, HOST_CLI_DOCUMENT_NAME, documentOf, isHostCliCommand, runHostCli } from "../src/hostCli.js";
import { hostCliDocumentContent } from "../src/hostCliDocument.js";
import { redactKeyShaped } from "../src/redact.js";
import { COMPAT_IGNORED_BY_CONTRACT, compatChatUrl, createHostedClient, hostedConfigured, hostedRun, type HostedPorts } from "../src/hosted.js";
import { isFreshStoreRootRace, startWithRetry, type Host } from "../src/runtime.js";
import type { Customer, Store, Ticket, TimelineEvent } from "../src/store.js";

// --- hosted ----------------------------------------------------------------------------------------------------------

const ticket: Ticket = { ticketId: "T-1", customerId: "cust-3003", subject: "s", body: "the ticket text", receivedAt: "2026-09-18T09:05:00Z", channel: "email", lastRun: null };
const customer: Customer = { customerId: "cust-3003", name: "Orbital Bank", tier: "enterprise", seats: 240, since: "2024-11-20" };

function hostedPorts(overrides: Partial<HostedPorts> = {}): HostedPorts & { runs: any[]; events: TimelineEvent[] } {
  const runs: any[] = [];
  const events: TimelineEvent[] = [];
  let t = 1_000_000;
  return {
    env: { hosted: { runKeyParameter: "/zudocs/staging/run-key", runUrl: "https://run.test", target: "staging" }, hostId: "us-east-1/lambda", region: "us-east-1", agentId: "agent_1" },
    store: { getCustomer: async (id) => (id === customer.customerId ? customer : null), putRun: async (run) => void runs.push(run), appendEvent: async (e) => void events.push(e) },
    readSecret: async (name) => { assert.equal(name, "/zudocs/staging/run-key"); return "apr_test_secret"; },
    now: () => (t += 25),
    runs,
    events,
    ...overrides,
  };
}

const catalogue = { agentId: "agent_1", target: "staging", generation: 1, releaseDigest: "sha256:abc", slots: [{ tag: "support.reply", kind: "prompt" as const, model: "amazon.nova-2-lite", variables: [{ name: "tone", required: false, trust: "operator" as const, default: "friendly" }, { name: "customer_tier", required: true, trust: "operator" as const, source: "runtime" as const }, { name: "ticket", required: true, trust: "end_user" as const }], inference: { temperatureMilli: 300, maxOutputTokens: 600 }, steps: null }], experiment: null, experiments: [{ experimentId: "exp_1", tag: "support.reply", salt: "c2FsdHNhbHRzYWx0c2FsdHNhbHQ", subjectKey: "request" as const, arms: ["control", "candidate"] }] };

function fakeManaged(options: { refuse?: { code: string; status: number; message: string } } = {}) {
  const started: unknown[] = [];
  const fed: unknown[] = [];
  const start = async (opts: any) => {
    started.push(opts);
    // The desk's variable source fills customer_tier before the POST; the fake reads it back to prove the wiring.
    const tier = await opts.variables.customer_tier.resolve({ subject: "cust-3003" });
    assert.equal(tier, "enterprise");
    return {
      slots: catalogue,
      subjectHashFor: (subject: string, tag: string) => `hash(${subject}|${tag})`,
      stream: async (tag: string, variables: Record<string, string>, o: { subject?: string }) => {
        if (options.refuse) {
          const error = Object.assign(new Error(`${options.refuse.code} (${options.refuse.status}): ${options.refuse.message}`), { name: "ManagedRunError", code: options.refuse.code, status: options.refuse.status });
          throw error;
        }
        assert.equal(tag, "support.reply");
        assert.equal(variables.tone, "formal", "an enterprise customer gets the formal tone at the call site");
        assert.equal(o.subject, "cust-3003");
        const deltas = ["Hello", " there", "."];
        const result = { runId: "run_1", runRef: "ref_1", output: deltas.join(""), model: "amazon.nova-2-lite", versionId: "rev-3", arm: "candidate", generation: 1, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 3 }, latencyMs: 800, priceMicros: 12, priceBookRevision: "pb-1", stopReason: "end_turn" as const, source: "executed" as const };
        const iterable = { async *[Symbol.asyncIterator]() { for (const d of deltas) yield d; }, result: Promise.resolve(result) };
        return iterable;
      },
      feedback: async (runRef: string, signals: Record<string, unknown>) => { fed.push({ runRef, signals }); return { accepted: true, attributedTo: { tag: "support.reply", versionId: "rev-3", arm: "candidate", minute: "2026-09-19T00:00" }, rejected: {} }; },
    } as any;
  };
  return { start, started, fed };
}

test("hosted: the stream's deltas keep their offsets, the feedback lands, and the compat call sits beside the sealed inference", async () => {
  const managed = fakeManaged();
  const compatCalls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    compatCalls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, headers: new Headers({ "x-airprompter-runref": "ref_2", "x-agent-run-id": "run_2" }), text: async () => JSON.stringify({ id: "chatcmpl", model: "slot:support.reply", choices: [{ message: { content: "Dear customer" }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30 }, airprompter: { runId: "run_2", runRef: "ref_2" } }) } as any;
  }) as any;
  const ports = hostedPorts({ managed, fetch: fetchImpl });
  const client = createHostedClient(ports);
  const record = await hostedRun({ ports, client, ticket, customer, by: "seth@zudocs.com" });
  assert.equal(record.kind, "hosted");
  assert.equal(record.ok, true);
  assert.deepEqual(record.gaps, []);
  assert.equal(record.subjectHash, "hash(cust-3003|support.reply)");
  assert.equal(record.stream.deltas.length, 3);
  assert.deepEqual(record.stream.deltas.map((d) => d.text), ["Hello", " there", "."]);
  assert.equal(record.stream.deltas[0]!.atMs, 0, "the first delta is the origin");
  assert.ok(record.stream.deltas[2]!.atMs > record.stream.deltas[1]!.atMs, "offsets grow with the clock");
  assert.equal(record.stream.result?.arm, "candidate");
  assert.equal(record.feedback?.accepted, true);
  assert.deepEqual(managed.fed, [{ runRef: "ref_1", signals: { thumbs: "up" } }]);
  assert.equal(record.catalogue.slot?.inference?.temperatureMilli, 300, "the catalogue's sealed settings are what the run used");
  assert.deepEqual(record.catalogue.experiments, [{ experimentId: "exp_1", tag: "support.reply", arms: ["control", "candidate"] }]);
  assert.equal(record.compat?.request.temperature, 1.9);
  assert.deepEqual(record.compat?.ignoredByContract, [...COMPAT_IGNORED_BY_CONTRACT], "the contract's word, carried on the record as such");
  assert.equal((record.compat as unknown as Record<string, unknown>).ignored, undefined, "no field pretends the response reported the ignoring");
  assert.equal("max_tokens" in compatCalls[0]!.body, false, "no cap on the request: the version's sealed cap is the one that applies");
  assert.equal(record.stream.firstByteMs !== null && record.stream.firstByteMs >= 0 && record.stream.firstByteMs < 200, true, "the first byte's offset counts from the POST, not from the client's start");
  assert.equal(record.compat?.response.runRef, "ref_2");
  assert.equal(record.compat?.response.text, "Dear customer");
  assert.equal(compatCalls.length, 1);
  assert.equal(compatCalls[0]!.url, compatChatUrl("https://run.test", "agent_1"));
  assert.equal(compatCalls[0]!.body.model, "slot:support.reply");
  assert.equal(compatCalls[0]!.body.airprompter.variables.customer_tier, "enterprise", "the compat call carries the desk's own variable");
  assert.equal(compatCalls[0]!.body.airprompter.variables.tone, "formal");
  assert.equal(compatCalls[0]!.body.airprompter.subjectHash, "hash(cust-3003|support.reply)");
  assert.equal(compatCalls[0]!.headers.authorization, "Bearer apr_test_secret");
  assert.equal(ports.runs.length, 1, "the record is stored");
  assert.equal(ports.events[0]?.kind, "hosted_run");
  assert.equal(managed.started.length, 1);
  await hostedRun({ ports, client, ticket, customer, by: "x" });
  assert.equal(managed.started.length, 1, "the client is started once per container");
});

test("hosted: a refusal is recorded in the route's own words, the record says which step, nothing is invented", async () => {
  const managed = fakeManaged({ refuse: { code: "internal", status: 500, message: "Internal error" } });
  const fetchImpl = (async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => JSON.stringify({ error: "Internal error", code: "internal" }) })) as any;
  const ports = hostedPorts({ managed, fetch: fetchImpl });
  const record = await hostedRun({ ports, client: createHostedClient(ports), ticket, customer, by: "x" });
  assert.equal(record.ok, false);
  assert.equal(record.stream.result, null);
  assert.equal(record.stream.refusal?.code, "internal");
  assert.equal(record.stream.refusal?.status, 500);
  assert.equal(record.feedback, null, "no run reference, no feedback");
  assert.equal(record.compat?.response.status, 500);
  assert.equal(record.compat?.response.error?.code, "internal");
  assert.equal(record.gaps.length, 2);
  assert.match(record.gaps[0]!, /the run route refused the stream: internal \(500\)/);
  assert.match(record.gaps[1]!, /the compatible endpoint answered 500/);
  assert.equal(record.catalogue.generation, 1, "the catalogue read still stands");
});

test("hosted: an unreadable run key parameter is a start refusal that names the parameter; the next call retries", async () => {
  let attempts = 0;
  const ports = hostedPorts({ readSecret: async () => { attempts += 1; throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } });
  const client = createHostedClient(ports);
  const record = await hostedRun({ ports, client, ticket, customer, by: "x" });
  assert.equal(record.ok, false);
  assert.match(record.gaps[0]!, /the SSM parameter \/zudocs\/staging\/run-key could not be read \(AccessDeniedException\)/);
  await hostedRun({ ports, client, ticket, customer, by: "x" });
  assert.equal(attempts, 2, "a failed read is not memoised");
  assert.equal(hostedConfigured({ hosted: { runKeyParameter: "", runUrl: "https://x", target: "staging" } }), false);
  assert.equal(hostedConfigured(ports.env), true);
});

// --- host CLI ---------------------------------------------------------------------------------------------------------

test("host CLI: the allowlist is closed, the JSON line is the last stdout line, polling ends on a terminal status", async () => {
  assert.equal(isHostCliCommand("policy show"), true);
  assert.equal(isHostCliCommand("policy set auto"), false, "inert on a daemon started with --apply-policy: not a drill");
  assert.equal(isHostCliCommand("policy show; rm -rf /"), false);
  assert.equal(isHostCliCommand("constructor"), false, "prototype names are not commands");
  assert.equal(isHostCliCommand("apply"), false, "apply --force is a laptop drill, never a one-click");
  for (const line of Object.values(HOST_CLI_COMMANDS)) assert.match(line, /^zudocs-cli [a-z ]+ --json$/, line);
  assert.deepEqual(documentOf('policy: unlock_required\n{"via":"daemon","applyPolicy":{"effective":"unlock_required"}}\n'), { via: "daemon", applyPolicy: { effective: "unlock_required" } });
  assert.equal(documentOf("not json"), null);
  const polls: string[] = [];
  let n = 0;
  const result = await runHostCli({
    region: "eu-west-1", nameTag: "zudocs-eu-host",
    send: async ({ command }) => { assert.equal(command, "policy show", "the document's parameter is the command's NAME; the line is the document's"); return { commandId: "cmd-1" }; },
    poll: async (id) => { polls.push(id); n += 1; return n < 3 ? { status: "InProgress", instanceId: "i-1", stdout: "", stderr: "" } : { status: "Success", instanceId: "i-1", stdout: 'in force: unlock_required (local)\n{"via":"daemon","applyPolicy":{"effective":"unlock_required","source":"local","manifestSaid":"auto"}}', stderr: "" }; },
    sleep: async () => undefined,
    now: (() => { let t = 0; return () => (t += 1000); })(),
  }, "policy show");
  assert.equal(polls.length, 3);
  assert.equal(result.status, "Success");
  assert.equal(result.instanceId, "i-1");
  assert.equal((result.document as any).applyPolicy.manifestSaid, "auto");
  assert.equal(summariseCli("policy show", result.document!), "in force unlock_required (local); the console says auto — advisory here");
  const none = await runHostCli({ region: "eu-west-1", nameTag: "zudocs-eu-host", send: async () => ({ commandId: "cmd-2" }), poll: async () => null, sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 60_000); })() }, "status", 10);
  assert.equal(none.status, "NoInstance");
  assert.equal(summariseCli("rollback", { generation: 3, previousGeneration: 4, forced: true }), "generation 3 live (was 4) — a forced downgrade, stamped on evidence");
  assert.equal(summariseCli("rollback", { via: "daemon", generation: 3, forced: true }), "generation 3 live — a forced downgrade, stamped on evidence", "the daemon's answer carries no previous generation");
  assert.equal(summariseCli("unlock", { ok: false, error: "not_staged" }), "refused: not_staged");
  assert.equal(summariseCli("unlock", { via: "daemon", generation: null }), "nothing was staged; nothing activated");
  assert.equal(HOST_CLI_DOCUMENT_NAME, "zudocs-desk-host-cli");
  const content = hostCliDocumentContent();
  assert.deepEqual(content.parameters.command.allowedValues, Object.keys(HOST_CLI_COMMANDS), "the document's allowed values are the allowlist");
  assert.deepEqual(content.mainSteps[0].inputs.runCommand, ["zudocs-cli {{ command }} --json"]);
});

test("redaction: the strips' key-shaped patterns replace what they match and count the hits; ordinary CLI output is untouched", () => {
  assert.deepEqual(redactKeyShaped("in force: unlock_required (local)\n{\"via\":\"daemon\",\"generation\":4}"), { text: "in force: unlock_required (local)\n{\"via\":\"daemon\",\"generation\":4}", hits: 0 });
  const hit = redactKeyShaped('{"ok":true,"token":"apa_abcdef123456","session":"apr_zyxwvu987654"}');
  assert.equal(hit.hits, 2);
  assert.equal(hit.text, '{"ok":true,"token":"[redacted]","session":"[redacted]"}');
  assert.deepEqual(documentOf(hit.text), { ok: true, token: "[redacted]", session: "[redacted]" }, "a redacted document still parses");
  const jwt = redactKeyShaped("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-def_ghi");
  assert.equal(jwt.hits, 1, "a bearer JWT is one span");
  assert.ok(!jwt.text.includes("eyJ") && jwt.text.startsWith("Authorization: Bearer [redacted]"), jwt.text);
  const env = redactKeyShaped("AIRPROMPTER_AGENT_KEY=apa_secret_value_123 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI AWS_SESSION_TOKEN=FwoGZXIvYXdzE");
  assert.equal(env.hits, 3, "an environment dump: every key variable, once each");
  assert.ok(!/apa_|wJalr|FwoGZ/.test(env.text), env.text);
  const pem = redactKeyShaped("-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIB\n-----END EC PRIVATE KEY-----\nafter");
  assert.equal(pem.text, "[redacted]\nafter");
  const jwk = redactKeyShaped('{"kty":"EC","d":"private-scalar","x":"pub"}');
  assert.equal(jwk.text, '{"kty":"EC","d":"[redacted]","x":"pub"}', "a JWK private member keeps its name, loses its value");
  assert.deepEqual(documentOf(jwk.text), { kty: "EC", d: "[redacted]", x: "pub" });
});

// --- arms ---------------------------------------------------------------------------------------------------------------

test("arms: the fold groups by slot, version and arm, counts feedback on the reply's arm, and finds the customer every host disagreed on under the same release", () => {
  const step = (tag: string, arm: string, versionId: string, judge: number | null, cost: number, pass = true, generation = 5) => ({ step: tag === "support.triage" ? "triage" : "reply", tag, versionId, arm, model: tag === "support.triage" ? "amazon.nova-micro" : "amazon.nova-2-lite", generation, observation: { latencyMs: 100 }, checks: [{ verdict: pass ? "pass" : "fail" }], costUsd: cost, judge: judge === null ? null : { score: judge }, error: null });
  const runs = [
    { runId: "r1", ticketId: "T-1", customerId: "cust-1", host: "us-east-1/lambda", steps: [step("support.triage", "control", "rev-2", null, 0.00001), step("support.reply", "candidate", "rev-6", 0.8, 0.001)] },
    { runId: "r2", ticketId: "T-1", customerId: "cust-1", host: "eu-west-1/ec2", steps: [step("support.triage", "control", "rev-2", null, 0.00001), step("support.reply", "candidate", "rev-6", 1, 0.002)] },
    { runId: "r3", ticketId: "T-2", customerId: "cust-2", host: "us-east-1/lambda", steps: [step("support.reply", "control", "rev-3", 0.5, 0.001, false)] },
    { runId: "r4", ticketId: "T-2", customerId: "cust-2", host: "eu-west-1/ec2", steps: [step("support.reply", "candidate", "rev-6", 0.5, 0.001)] },
    { runId: "h1", ticketId: "T-1", customerId: "cust-1", host: "us-east-1/lambda", kind: "hosted", steps: [] },
  ];
  const feedback = [{ runId: "r1", signals: { thumbs: "up" }, filed: true }, { runId: "r1", signals: { accepted: true }, filed: true }, { runId: "r3", signals: { thumbs: "down" }, filed: true }, { runId: "r4", signals: { thumbs: "up" }, filed: false }];
  const { arms, stickiness } = foldArms(runs as any, feedback as any);
  const candidate = arms.find((a) => a.tag === "support.reply" && a.arm === "candidate")!;
  assert.equal(candidate.runs, 3);
  assert.deepEqual(candidate.hosts, { "us-east-1/lambda": 1, "eu-west-1/ec2": 2 });
  assert.equal(candidate.judgeMean, 0.767);
  assert.equal(candidate.feedback.up, 1);
  assert.equal(candidate.feedback.accepted, 1);
  assert.equal(candidate.checksFailed, 0);
  const control = arms.find((a) => a.tag === "support.reply" && a.arm === "control")!;
  assert.equal(control.feedback.down, 1);
  assert.equal(control.checksFailed, 1);
  assert.equal(arms.find((a) => a.tag === "support.triage")?.runs, 2);
  assert.deepEqual(stickiness, [
    { customerId: "cust-1", tag: "support.reply", generation: 5, arms: { "us-east-1/lambda": "candidate", "eu-west-1/ec2": "candidate" }, consistent: true },
    { customerId: "cust-2", tag: "support.reply", generation: 5, arms: { "us-east-1/lambda": "control", "eu-west-1/ec2": "candidate" }, consistent: false },
    { customerId: "cust-1", tag: "support.triage", generation: 5, arms: { "us-east-1/lambda": "control", "eu-west-1/ec2": "control" }, consistent: true },
  ], "one row per customer, experiment and release (an arm of none is no experiment); a hosted run is not part of the fold");

  // A dial: generation 6 carries new weights, and cust-3's bucket moved from the control to the candidate. Before the
  // dial both hosts served the control; after it both serve the candidate — two rows, both consistent, never "control+candidate".
  const dialled = [
    { runId: "d1", ticketId: "T-3", customerId: "cust-3", host: "us-east-1/lambda", steps: [step("support.reply", "control", "rev-3", 0.7, 0.001)] },
    { runId: "d2", ticketId: "T-3", customerId: "cust-3", host: "eu-west-1/ec2", steps: [step("support.reply", "control", "rev-3", 0.7, 0.001)] },
    { runId: "d3", ticketId: "T-3", customerId: "cust-3", host: "us-east-1/lambda", steps: [step("support.reply", "candidate", "rev-6", 0.9, 0.001, true, 6)] },
    { runId: "d4", ticketId: "T-3", customerId: "cust-3", host: "eu-west-1/ec2", steps: [step("support.reply", "candidate", "rev-6", 0.9, 0.001, true, 6)] },
    // eu-west still on 6 when us-east has moved to 7: not comparable yet, and not a disagreement.
    { runId: "d5", ticketId: "T-3", customerId: "cust-3", host: "us-east-1/lambda", steps: [step("support.reply", "control", "rev-3", 0.7, 0.001, true, 7)] },
    // A run that recorded no generation folds under null, never with a numbered one.
    { runId: "d6", ticketId: "T-3", customerId: "cust-3", host: "us-east-1/lambda", steps: [step("support.reply", "candidate", "rev-6", 0.9, 0.001, true, null as unknown as number)] },
  ];
  const after = foldArms(dialled as any, []).stickiness;
  assert.deepEqual(after, [
    { customerId: "cust-3", tag: "support.reply", generation: null, arms: { "us-east-1/lambda": "candidate" }, consistent: true },
    { customerId: "cust-3", tag: "support.reply", generation: 5, arms: { "us-east-1/lambda": "control", "eu-west-1/ec2": "control" }, consistent: true },
    { customerId: "cust-3", tag: "support.reply", generation: 6, arms: { "us-east-1/lambda": "candidate", "eu-west-1/ec2": "candidate" }, consistent: true },
    { customerId: "cust-3", tag: "support.reply", generation: 7, arms: { "us-east-1/lambda": "control" }, consistent: true },
  ], "a customer whose bucket moved with a dial is consistent on every release; the old fold would have read control+candidate");
  assert.ok(after.every((s) => s.consistent), "after a dial every row is consistent");
});

// --- handler --------------------------------------------------------------------------------------------------------------

function fakeStore(): Store & { runs: Map<string, any>; events: TimelineEvent[]; feedback: any[]; used: number; approvals: Map<string, any> } {
  const customers: Customer[] = [customer];
  const tickets: Ticket[] = [ticket];
  const self: any = {
    runs: new Map<string, any>(), events: [] as TimelineEvent[], feedback: [] as any[], used: 0, approvals: new Map<string, any>(),
    listCustomers: async () => customers, getCustomer: async (id: string) => customers.find((c) => c.customerId === id) ?? null,
    listTickets: async () => tickets, getTicket: async (id: string) => tickets.find((t) => t.ticketId === id) ?? null,
    putRun: async (run: any) => void self.runs.set(run.runId, run), getRun: async (id: string) => self.runs.get(id) ?? null, listRunsForTicket: async () => [...self.runs.values()],
    updateTicketLastRun: async () => undefined, putFeedback: async (row: any) => void self.feedback.push(row), listFeedback: async () => self.feedback,
    putStatus: async () => undefined, updateStatus: async () => undefined, listStatus: async () => [],
    appendEvent: async (e: TimelineEvent) => void self.events.push(e), listEvents: async () => self.events,
    takeRunSlot: async () => ({ ok: true, used: ++self.used }), readRunSlots: async () => self.used,
    seed: async (c: Customer[], t: Ticket[]) => ({ customers: c.length, tickets: t.length }),
    enqueueTicket: async () => 1, dequeueTicket: async () => null,
    openApproval: async () => ({ created: true }), getApproval: async (id: string) => self.approvals.get(id) ?? null, listApprovals: async () => [...self.approvals.values()],
    approve: async () => ({ ok: false, row: null }), settleApproval: async () => null,
    listRuns: async () => [...self.runs.values()], listAllFeedback: async () => self.feedback,
    reset: async (c: Customer[], t: Ticket[]) => { const counts = { runs: self.runs.size, feedback: self.feedback.length, approvals: self.approvals.size, events: self.events.length, counters: 1, customers: c.length, tickets: t.length }; self.runs.clear(); self.feedback.length = 0; self.approvals.clear(); self.events.length = 0; return counts; },
  };
  return self;
}

function fakeHost(options: { frozen?: boolean; freezeOnInvoke?: boolean; ramps?: unknown[]; hostCliThrows?: string; hostCliStdout?: string; hostCliStderr?: string } = {}) {
  const store = fakeStore();
  const calls: string[] = [];
  const state = { frozen: options.frozen ?? false, policy: "auto", source: "local", generation: 7 };
  const status = () => ({ generation: state.generation, stagedGeneration: null, applyState: "active", variables: { sources: ["customer_tier"], unsourced: [] }, heartbeat: { lastAt: null, nextAt: null, intervalSeconds: 60, lastRefusal: null }, storageProtection: "kms", source: "store", applyPolicy: { effective: state.policy, source: state.source, manifestSaid: "auto" }, lastSyncOutcome: "unchanged", disabled: { agent: state.frozen, slots: [], arms: [] }, lastRefusal: state.frozen ? "disabled: frozen from the console" : null, ramps: options.ramps ?? [] });
  const ap: any = {
    instanceId: "i-fake", generation: state.generation, status, healthz: () => ({ ok: true, status: "ok", reasons: [] }),
    // `freezeOnInvoke`: the host is built unfrozen and the invoke's sync pass is what verifies the directive — a check
    // made before the invoke would see an unfrozen host and take a cap slot.
    invoke: async (fn: () => Promise<unknown>) => { calls.push("invoke"); if (options.freezeOnInvoke) state.frozen = true; return fn(); },
    prompt: () => ({ variables: () => [], renderAsync: async () => { throw new Error("not rendered in this test"); } }),
    setApplyPolicy: async (value: string, input: { by?: string }) => { calls.push(`setApplyPolicy:${value}:${input.by}`); state.policy = value; state.source = "operator"; return { effective: value, source: "operator", manifestSaid: "auto" }; },
    golden: async (o: { tag?: string }) => { calls.push(`golden:${o.tag ?? "*"}`); return [{ tag: "support.triage", arm: "control", setId: "gs", model: "amazon.nova-micro", cases: 5, passed: 1, failed: 4, passBps: 2000, minPassBps: 8000, meetsThreshold: false, results: [{ caseId: "billing-double-charge", ok: false, failed: ["category"] }, { caseId: "other-dark-mode", ok: true, failed: [] }] }]; },
    feedback: () => true, heartbeatNow: async () => undefined, syncNow: async () => undefined, flushTelemetry: async () => ({ status: "nothing" }), uploadNow: async () => null, spool: { observe: () => {} }, onChange: () => () => {},
  };
  const env = { tables: {} as any, kmsKeyId: "k", agentKeyParameter: "/p", wireFunctionArn: "arn:aws:lambda:eu-west-1:1:function:zudocs-wire", nudgeQueueUrl: "", powerFunctionArn: "", demoModeParameter: "", hosted: { runKeyParameter: "", runUrl: "", target: "staging" }, providers: { openai: { keyParameter: "", model: "gpt-5.6-luna" }, anthropic: { keyParameter: "", model: "claude-opus-5" } }, euHost: { region: "eu-west-1", nameTag: "zudocs-eu-host" }, airprompter: { baseUrl: "https://api-dev.airprompter.com", organizationId: "o", agentId: "a", environment: "dev", hostedEnvironment: "dev", rootUrl: "u", rootJwk: "{}" }, dailyRunCap: 2, stateEpoch: "1", stateDir: "/tmp/airprompter/1", hostId: "us-east-1/lambda", region: "us-east-1", emfNamespace: "Zudocs/Desk", functionName: "", heartbeatSeconds: 60 } as Host["env"];
  const host: Host & { store: ReturnType<typeof fakeStore>; calls: string[] } = {
    env, ap, store, calls, callers: { judgeModel: "amazon.nova-micro", complete: async () => ({ text: "", response: {} }), judge: async () => "", golden: async () => ({ text: "", outputTokens: null }) }, hosted: null,
    hostCli: async (command) => { calls.push(`host_cli:${command}`); if (options.hostCliThrows) throw new Error(options.hostCliThrows); const stdout = options.hostCliStdout ?? "{}"; return { command, line: `zudocs-cli ${command} --json`, status: "Success", instanceId: "i-eu", document: options.hostCliStdout ? documentOf(stdout) : command === "policy show" ? { via: "daemon", applyPolicy: { effective: "unlock_required", source: "local", manifestSaid: "auto" } } : { ok: true }, stdout, stderr: options.hostCliStderr ?? "", durationMs: 1200 }; },
    startedAt: "2026-09-18T10:00:00Z", sdk: "agent-sdk-ts/test", invocations: 0, coldStart: true,
    observed: async (fn) => ({ result: await fn(), error: undefined, observations: [] }),
    writeStatus: async () => undefined,
    nudge: async () => ({ messageId: null }),
    power: async (action, by) => ({ action, hostId: "eu-west-1/ec2", instanceId: "i-eu", state: "running", changed: false, refusal: null, marker: null, message: `${action} by ${by}` }),
    demoMode: null,
  };
  return host;
}

const event = (method: string, rawPath: string, body?: unknown): APIGatewayProxyEventV2WithJWTAuthorizer => ({ version: "2.0", routeKey: "$default", rawPath, rawQueryString: "", headers: {}, requestContext: { accountId: "1", apiId: "a", domainName: "d", domainPrefix: "d", http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "1.1.1.1", userAgent: "t" }, requestId: "r", routeKey: "$default", stage: "$default", time: "", timeEpoch: 0, authorizer: { principalId: "p", integrationLatency: 0, jwt: { claims: { email: "seth@zudocs.com" }, scopes: [] } } }, isBase64Encoded: false, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) } as any);
const parse = (r: any) => ({ status: r.statusCode as number, body: JSON.parse(r.body) as any });

test("handler: a frozen host refuses a run inside the invoke (after the sync), takes no cap slot, and /state syncs first and says frozen", async () => {
  // Built unfrozen: only the invoke's sync pass freezes it, so a refusal proves the check ran inside the invoke.
  const host = fakeHost({ freezeOnInvoke: true });
  assert.deepEqual(frozenOf(host), { frozen: false, reason: null }, "not frozen before the first invoke");
  const handler = createHandler(async () => host);
  const run = parse(await handler(event("POST", "/tickets/T-1/run")));
  assert.equal(run.status, 423);
  assert.equal(run.body.error, "frozen");
  assert.equal(run.body.reason, FROZEN_REASON, "a fixed reason: lastRefusal may name another refusal entirely");
  assert.deepEqual(host.calls, ["invoke"], "the check ran inside the invoke, after its sync pass");
  assert.equal(host.store.used, 0, "the cap is not taken for a refused run");
  assert.equal(host.store.events[0]?.kind, "run_refused");
  // The replay job takes the same path: the freeze the invoke verified refuses before a slot is taken.
  const replayHost = fakeHost({ freezeOnInvoke: true });
  await createHandler(async () => replayHost)({ replay: { n: 3, by: "seth@zudocs.com" } });
  assert.equal(replayHost.store.used, 0, "no cap slot taken by a frozen replay");
  assert.deepEqual(replayHost.store.events.map((e) => e.kind), ["run_refused", "replay_done"]);
  assert.equal(replayHost.store.events[1]?.done, 0);
  host.calls.length = 0;
  const state = parse(await handler(event("GET", "/state")));
  assert.deepEqual(state.body.frozen, { frozen: true, reason: FROZEN_REASON });
  assert.deepEqual(host.calls, ["invoke"], "/state answers after a sync pass, so every warm container tells the same story");
  assert.deepEqual(state.body.features, { wire: true, nudge: false, hosted: false, openai: false, anthropic: false, hostCli: true, power: false, demoMode: false });
  assert.deepEqual(frozenOf(fakeHost()), { frozen: false, reason: null });
});

test("handler: host_cli takes the allowlist only and runs as a job whose answer lands on the timeline; policy goes through setApplyPolicy, golden reports counts, reset clears", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const bad = parse(await handler(event("POST", "/presenter/host_cli", { command: "policy show && cat /etc/passwd" })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "no_such_command");
  const noName = parse(await handler(event("POST", "/presenter/host_cli", { command: "policy show" })));
  assert.equal(noName.status, 501, "no function name, no self-invoke");
  assert.equal(noName.body.error, "no_self_invoke");
  // The job itself (what the self-invoke delivers): the CLI's document on the timeline.
  await handler({ hostCli: { command: "policy show", by: "seth@zudocs.com", requestedAt: "2026-09-19T00:00:00Z" } });
  const row = host.store.events.at(-1)!;
  assert.equal(row.kind, "host_cli");
  assert.equal(row.forHost, "eu-west-1/ec2");
  assert.equal(row.summary, "in force unlock_required (local); the console says auto — advisory here");
  assert.equal((row.document as any).applyPolicy.manifestSaid, "auto", "the CLI's own document rides on the row");
  assert.deepEqual(host.calls.filter((c) => c.startsWith("host_cli")), ["host_cli:policy show"]);
  const policy = parse(await handler(event("POST", "/presenter/policy", { value: "auto" })));
  assert.equal(policy.status, 200);
  assert.match(policy.body.message, /already auto/);
  assert.equal(host.calls.filter((c) => c.startsWith("setApplyPolicy")).at(-1), "setApplyPolicy:auto:seth@zudocs.com");
  const tightened = parse(await handler(event("POST", "/presenter/policy", { value: "unlock_required" })));
  assert.match(tightened.body.message, /auto → unlock_required \(operator\)/);
  const badPolicy = parse(await handler(event("POST", "/presenter/policy", { value: "whatever" })));
  assert.equal(badPolicy.status, 400);
  const golden = parse(await handler(event("POST", "/presenter/golden", { tag: "support.triage" })));
  assert.equal(golden.status, 200);
  assert.equal(golden.body.reports[0].passed, 1);
  assert.equal(golden.body.reports[0].meetsThreshold, false);
  assert.deepEqual(golden.body.reports[0].failedCases[0], { caseId: "billing-double-charge", failed: ["category"], error: null });
  assert.match(golden.body.message, /support.triage \(control\): 1\/5 BELOW the 80% floor/);
  assert.equal(host.store.events.at(-1)?.kind, "golden_run");
  host.store.runs.set("r1", { runId: "r1", ticketId: "T-1", customerId: "cust-3003", host: "us-east-1/lambda", steps: [{ step: "reply", tag: "support.reply", versionId: "rev-6", arm: "candidate", model: "amazon.nova-2-lite", checks: [], costUsd: 0.001, judge: { score: 1 }, error: null }] });
  const arms = parse(await handler(event("GET", "/arms")));
  assert.equal(arms.status, 200);
  assert.equal(arms.body.arms[0].arm, "candidate");
  assert.equal(arms.body.runsRead, 1);
  const reset = parse(await handler(event("POST", "/presenter/reset")));
  assert.equal(reset.status, 200);
  assert.equal(reset.body.runs, 1);
  assert.match(reset.body.message, /cleared 1 runs/);
  assert.equal(host.store.runs.size, 0);
  const hosted = parse(await handler(event("POST", "/tickets/T-1/hosted-run")));
  assert.equal(hosted.status, 501);
  assert.equal(hosted.body.error, "hosted_not_configured");
});

test("handler: an approval row carries the ramp plan this host read from the same generation, and none for another", async () => {
  const plan = [{ notBefore: "2026-09-19T01:00:00Z", weightBps: [9000, 1000] }, { notBefore: "2026-09-19T02:00:00Z", weightBps: [5000, 5000] }];
  const host = fakeHost({ ramps: [{ experimentId: "exp_1", tag: "support.reply", weightBps: [9000, 1000], arms: ["control", "candidate"], step: 0, nextStepAt: "2026-09-19T02:00:00Z", plan }] });
  host.store.approvals.set("eu-west-1-ec2-g7-s", { approvalId: "eu-west-1-ec2-g7-s", hostId: "eu-west-1/ec2", storeId: "s", generation: 7, releaseDigest: null, stagedAt: "2026-09-19T00:00:00Z", unlockRequest: null, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: "2026-09-19T00:00:00Z" });
  host.store.approvals.set("eu-west-1-ec2-g6-s", { approvalId: "eu-west-1-ec2-g6-s", hostId: "eu-west-1/ec2", storeId: "s", generation: 6, releaseDigest: null, stagedAt: "2026-09-18T00:00:00Z", unlockRequest: null, decision: "activated", decidedBy: "x", decidedAt: null, activatedAt: null, outcome: null, updatedAt: "2026-09-18T00:00:00Z" });
  const handler = createHandler(async () => host);
  const list = parse(await handler(event("GET", "/approvals")));
  const g7 = list.body.approvals.find((a: any) => a.generation === 7);
  assert.equal(g7.ramps.length, 1);
  assert.deepEqual(g7.ramps[0].plan, plan);
  assert.equal(g7.ramps[0].readBy, "us-east-1/lambda");
  assert.deepEqual(list.body.approvals.find((a: any) => a.generation === 6).ramps, []);
});

test("handler: a host-CLI job whose Run Command cannot be sent lands on the timeline as a Failed row, never as a throw", async () => {
  const host = fakeHost({ hostCliThrows: "no instance with tag Name=zudocs-eu-host is running" });
  const handler = createHandler(async () => host);
  await handler({ hostCli: { command: "doctor", by: "seth@zudocs.com", requestedAt: "2026-09-19T00:00:00Z" } });
  const row = host.store.events.at(-1)!;
  assert.equal(row.kind, "host_cli");
  assert.equal(row.status, "Failed");
  assert.equal(row.command, "doctor");
  assert.equal(row.line, "zudocs-cli doctor --json");
  assert.equal(row.instanceId, null);
  assert.equal(row.document, null);
  assert.match(String(row.summary), /Run Command could not be sent: no instance with tag/);
  assert.equal(row.by, "seth@zudocs.com");
});

test("handler: a host-CLI job's stdout and stderr go through the key-shaped scan before the row is written; a hit is redacted, counted and said, and the document is re-read from the redacted text", async () => {
  const clean = fakeHost({ hostCliStdout: 'in force: unlock_required (local)\n{"via":"daemon","generation":4,"signingKeyId":"key_01HZ"}' });
  await createHandler(async () => clean)({ hostCli: { command: "status", by: "seth@zudocs.com", requestedAt: "2026-09-19T00:00:00Z" } });
  const untouched = clean.store.events.at(-1)!;
  assert.equal(untouched.redacted, 0, "ordinary output: nothing redacted");
  assert.deepEqual(untouched.document, { via: "daemon", generation: 4, signingKeyId: "key_01HZ" });
  assert.equal(untouched.stdout, 'in force: unlock_required (local)\n{"via":"daemon","generation":4,"signingKeyId":"key_01HZ"}');

  const leaky = fakeHost({ hostCliStdout: '{"ok":true,"generation":4,"env":{"AIRPROMPTER_AGENT_KEY":"apa_leaked_key_000001"}}', hostCliStderr: "warn: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig" });
  await createHandler(async () => leaky)({ hostCli: { command: "doctor", by: "seth@zudocs.com", requestedAt: "2026-09-19T00:00:00Z" } });
  const row = leaky.store.events.at(-1)!;
  assert.equal(row.kind, "host_cli");
  assert.equal(row.status, "Success");
  assert.equal(row.redacted, 2, "one span in stdout, one in stderr");
  const stored = JSON.stringify(row);
  assert.ok(!stored.includes("apa_leaked") && !stored.includes("eyJ"), `nothing key-shaped on the row: ${stored}`);
  assert.equal(row.stdout, '{"ok":true,"generation":4,"env":{"AIRPROMPTER_AGENT_KEY":"[redacted]"}}');
  assert.equal(row.stderr, "warn: Authorization: Bearer [redacted]");
  assert.deepEqual(row.document, { ok: true, generation: 4, env: { AIRPROMPTER_AGENT_KEY: "[redacted]" } }, "the document is the redacted text's, not the raw one's");
  assert.match(String(row.summary), /2 key-shaped span\(s\) in the host's output were redacted/);

  const throwing = fakeHost({ hostCliThrows: "SendCommand refused for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y" });
  await createHandler(async () => throwing)({ hostCli: { command: "status", by: "seth@zudocs.com", requestedAt: "2026-09-19T00:00:00Z" } });
  assert.ok(!JSON.stringify(throwing.store.events.at(-1)).includes("eyJ"), "the throw path's message is scanned too");
});

test("approvalStaleness: a newer row on the same host and store, or the host's later status row naming another staged generation, makes a row stale; an older status row or another store does not", () => {
  const row = (id: string, generation: number, decision: any = "pending", storeId = "s", hostId = "eu-west-1/ec2"): any => ({ approvalId: id, hostId, storeId, generation, releaseDigest: null, stagedAt: "2026-09-19T00:10:00Z", unlockRequest: null, decision, decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: "2026-09-19T00:10:00Z" });
  const status = (writtenAt: string, generation: number, stagedGeneration: number | null, hostId = "eu-west-1/ec2"): any => ({ hostId, region: "eu-west-1", kind: "daemon", sdk: "x", writtenAt, status: { generation, stagedGeneration }, healthz: {}, container: {} });
  const g7 = row("g7", 7);
  assert.deepEqual(approvalStaleness(g7, [g7], []), { stale: false, reason: null }, "alone, current");
  assert.deepEqual(approvalStaleness(g7, [g7], [status("2026-09-19T00:11:00Z", 6, 7)]), { stale: false, reason: null }, "the host still holds it staged");
  const newer = approvalStaleness(g7, [g7, row("g8", 8)], []);
  assert.equal(newer.stale, true);
  assert.match(newer.reason!, /#8 was staged in its place \(its own row is pending\)/);
  assert.equal(approvalStaleness(g7, [g7, row("g8", 8, "pending", "other-store")], []).stale, false, "a newer row on another store is another instance's");
  assert.equal(approvalStaleness(g7, [g7, row("g8", 8, "pending", "s", "other/host")], []).stale, false, "another host's row");
  const live = approvalStaleness(g7, [g7], [status("2026-09-19T00:12:00Z", 7, null)]);
  assert.equal(live.stale, true);
  assert.match(live.reason!, /#7 is live and nothing is staged/);
  const other = approvalStaleness(g7, [g7], [status("2026-09-19T00:12:00Z", 6, 8)]);
  assert.equal(other.stale, true);
  assert.match(other.reason!, /#8 is staged \(#6 live\)/);
  assert.equal(approvalStaleness(g7, [g7], [status("2026-09-19T00:09:00Z", 6, null)]).stale, false, "a status row older than the staging says nothing about it");
  assert.equal(approvalStaleness(g7, [g7], [status("2026-09-19T00:12:00Z", 6, null)]).stale, false, "nothing staged and an older generation live: a store the row does not describe; the watcher decides");
});

test("handler: approving a row the host has moved past answers 409 approval_stale with the row and records no decision; a current row is approved once", async () => {
  const host = fakeHost();
  const mk = (id: string, generation: number): any => ({ approvalId: id, hostId: "eu-west-1/ec2", storeId: "s", generation, releaseDigest: null, stagedAt: "2026-09-19T00:10:00Z", unlockRequest: null, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: "2026-09-19T00:10:00Z" });
  host.store.approvals.set("g7", mk("g7", 7));
  host.store.approvals.set("g8", mk("g8", 8));
  const approved: string[] = [];
  host.store.approve = async (id: string, by: string, at: string) => { const r = host.store.approvals.get(id); if (!r || r.decision !== "pending") return { ok: false, row: r ?? null }; approved.push(id); Object.assign(r, { decision: "approved", decidedBy: by, decidedAt: at }); return { ok: true, row: r }; };
  const handler = createHandler(async () => host);
  const stale = parse(await handler(event("POST", "/approvals/g7/approve")));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "approval_stale");
  assert.match(stale.body.message, /release #7 is no longer what eu-west-1\/ec2 holds staged: #8 was staged in its place/);
  assert.equal(stale.body.approval.decision, "pending", "the row is handed back as it is; the host settles it");
  assert.deepEqual(approved, [], "no decision recorded");
  assert.equal(host.store.events.filter((e) => e.kind === "approval_decided").length, 0);
  const fresh = parse(await handler(event("POST", "/approvals/g8/approve")));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.already, false);
  assert.deepEqual(approved, ["g8"]);
  assert.equal(host.store.events.at(-1)?.kind, "approval_decided");
  const again = parse(await handler(event("POST", "/approvals/g8/approve")));
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true, "a settled or decided row is never re-checked for staleness, only answered as it stands");
  const missing = parse(await handler(event("POST", "/approvals/nope/approve")));
  assert.equal(missing.status, 404);
});

test("startWithRetry: SDK #52's fresh-store signature is retried once and logged; any other failure, or a second failure, is thrown as it is", async () => {
  const race = Object.assign(new Error("no verified release in the store, no usable vendored bundle, and the control plane at https://api-dev.airprompter.com could not be reached: slot A failed verification: unknown_signing_key"), { name: "AgentStartError", code: "no_verified_release" });
  assert.equal(isFreshStoreRootRace(race), true);
  assert.equal(isFreshStoreRootRace(Object.assign(new Error("slot A failed verification: unknown_signing_key"), { code: "other" })), false, "the code matters");
  assert.equal(isFreshStoreRootRace(Object.assign(new Error("could not be reached: ECONNRESET"), { code: "no_verified_release" })), false, "a real network failure is not the race");
  assert.equal(isFreshStoreRootRace(null), false);
  const logs: Record<string, unknown>[] = [];
  let starts = 0;
  const host = { startedAt: "x" } as unknown as Host;
  const once = await startWithRetry(async () => { starts += 1; if (starts === 1) throw race; return host; }, (e) => void logs.push(e));
  assert.equal(once, host);
  assert.equal(starts, 2);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.event, "host_start_retried");
  assert.equal(logs[0]!.issue, "airprompter-agent-sdk#52");
  starts = 0;
  await assert.rejects(startWithRetry(async () => { starts += 1; throw race; }, () => undefined), /unknown_signing_key/);
  assert.equal(starts, 2, "retried once, then thrown");
  starts = 0;
  await assert.rejects(startWithRetry(async () => { starts += 1; throw Object.assign(new Error("the SSM parameter has no value"), { code: "no_key" }); }, () => undefined), /SSM/);
  assert.equal(starts, 1, "not the race: no retry");
});
