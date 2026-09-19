/**
 * Phase 6 units: the hosted run record over a fake managed client and a fake compatible endpoint (the stream's
 * deltas with their offsets, the feedback, the compat request beside the catalogue's sealed inference, a refusal
 * recorded in the route's words and never retried); the host CLI's allowlist, its JSON-line reading and its
 * Run Command polling over fake ports; the per-arm fold with the stickiness table; and the handler's new paths —
 * a frozen host refuses a run with the SDK's reason before the cap is taken, `host_cli` refuses anything off the
 * allowlist, `policy` goes through `setApplyPolicy`, `golden` reports counts only, `reset` clears and re-seeds,
 * `/arms` folds the desk's own records, and an approval row carries the ramp plan this host read.
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
import { createHandler, frozenOf, summariseCli } from "../src/handler.js";
import { HOST_CLI_COMMANDS, documentOf, isHostCliCommand, runHostCli } from "../src/hostCli.js";
import { COMPAT_IGNORED, compatChatUrl, createHostedClient, hostedConfigured, hostedRun, type HostedPorts } from "../src/hosted.js";
import type { Host } from "../src/runtime.js";
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
  assert.deepEqual(record.compat?.ignored, [...COMPAT_IGNORED]);
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
  assert.equal(isHostCliCommand("policy set auto"), true);
  assert.equal(isHostCliCommand("policy set auto; rm -rf /"), false);
  assert.equal(isHostCliCommand("constructor"), false, "prototype names are not commands");
  assert.equal(isHostCliCommand("apply"), false, "apply --force is a laptop drill, never a one-click");
  for (const line of Object.values(HOST_CLI_COMMANDS)) assert.match(line, /^zudocs-cli [a-z_ ]+( --by desk)? --json$/, line);
  assert.deepEqual(documentOf('policy: unlock_required\n{"via":"daemon","applyPolicy":{"effective":"unlock_required"}}\n'), { via: "daemon", applyPolicy: { effective: "unlock_required" } });
  assert.equal(documentOf("not json"), null);
  const polls: string[] = [];
  let n = 0;
  const result = await runHostCli({
    region: "eu-west-1", nameTag: "zudocs-eu-host",
    send: async ({ command }) => { assert.equal(command, "zudocs-cli policy show --json"); return { commandId: "cmd-1" }; },
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
  assert.equal(summariseCli("unlock", { ok: false, error: "not_staged" }), "refused: not_staged");
});

// --- arms ---------------------------------------------------------------------------------------------------------------

test("arms: the fold groups by slot, version and arm, counts feedback on the reply's arm, and finds the customer every host disagreed on", () => {
  const step = (tag: string, arm: string, versionId: string, judge: number | null, cost: number, pass = true) => ({ step: tag === "support.triage" ? "triage" : "reply", tag, versionId, arm, model: tag === "support.triage" ? "amazon.nova-micro" : "amazon.nova-2-lite", observation: { latencyMs: 100 }, checks: [{ verdict: pass ? "pass" : "fail" }], costUsd: cost, judge: judge === null ? null : { score: judge }, error: null });
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
    { customerId: "cust-1", tag: "support.reply", arms: { "us-east-1/lambda": "candidate", "eu-west-1/ec2": "candidate" }, consistent: true },
    { customerId: "cust-2", tag: "support.reply", arms: { "us-east-1/lambda": "control", "eu-west-1/ec2": "candidate" }, consistent: false },
    { customerId: "cust-1", tag: "support.triage", arms: { "us-east-1/lambda": "control", "eu-west-1/ec2": "control" }, consistent: true },
  ], "one row per customer and experiment (an arm of none is no experiment); a hosted run is not part of the fold");
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

function fakeHost(options: { frozen?: boolean; ramps?: unknown[] } = {}) {
  const store = fakeStore();
  const calls: string[] = [];
  const state = { frozen: options.frozen ?? false, policy: "auto", source: "local", generation: 7 };
  const status = () => ({ generation: state.generation, stagedGeneration: null, applyState: "active", variables: { sources: ["customer_tier"], unsourced: [] }, heartbeat: { lastAt: null, nextAt: null, intervalSeconds: 60, lastRefusal: null }, storageProtection: "kms", source: "store", applyPolicy: { effective: state.policy, source: state.source, manifestSaid: "auto" }, lastSyncOutcome: "unchanged", disabled: { agent: state.frozen, slots: [], arms: [] }, lastRefusal: state.frozen ? "disabled: frozen from the console" : null, ramps: options.ramps ?? [] });
  const ap: any = {
    instanceId: "i-fake", generation: state.generation, status, healthz: () => ({ ok: true, status: "ok", reasons: [] }),
    invoke: async (fn: () => Promise<unknown>) => fn(),
    prompt: () => ({ variables: () => [], renderAsync: async () => { throw new Error("not rendered in this test"); } }),
    setApplyPolicy: async (value: string, input: { by?: string }) => { calls.push(`setApplyPolicy:${value}:${input.by}`); state.policy = value; state.source = "operator"; return { effective: value, source: "operator", manifestSaid: "auto" }; },
    golden: async (o: { tag?: string }) => { calls.push(`golden:${o.tag ?? "*"}`); return [{ tag: "support.triage", arm: "control", setId: "gs", model: "amazon.nova-micro", cases: 5, passed: 1, failed: 4, passBps: 2000, minPassBps: 8000, meetsThreshold: false, results: [{ caseId: "billing-double-charge", ok: false, failed: ["category"] }, { caseId: "other-dark-mode", ok: true, failed: [] }] }]; },
    feedback: () => true, heartbeatNow: async () => undefined, syncNow: async () => undefined, flushTelemetry: async () => ({ status: "nothing" }), uploadNow: async () => null, spool: { observe: () => {} }, onChange: () => () => {},
  };
  const env = { tables: {} as any, kmsKeyId: "k", agentKeyParameter: "/p", wireFunctionArn: "arn:aws:lambda:eu-west-1:1:function:zudocs-wire", nudgeQueueUrl: "", hosted: { runKeyParameter: "", runUrl: "", target: "staging" }, euHost: { region: "eu-west-1", nameTag: "zudocs-eu-host" }, airprompter: { baseUrl: "https://api-dev.airprompter.com", organizationId: "o", agentId: "a", environment: "dev", hostedEnvironment: "dev", rootUrl: "u", rootJwk: "{}" }, dailyRunCap: 2, stateEpoch: "1", stateDir: "/tmp/airprompter/1", hostId: "us-east-1/lambda", region: "us-east-1", emfNamespace: "Zudocs/Desk", functionName: "", heartbeatSeconds: 60 } as Host["env"];
  const host: Host & { store: ReturnType<typeof fakeStore>; calls: string[] } = {
    env, ap, store, calls, callers: { judgeModel: "amazon.nova-micro", complete: async () => ({ text: "", response: {} }), judge: async () => "", golden: async () => ({ text: "", outputTokens: null }) }, hosted: null,
    hostCli: async (command) => { calls.push(`host_cli:${command}`); return { command, line: `zudocs-cli ${command} --json`, status: "Success", instanceId: "i-eu", document: command === "policy show" ? { via: "daemon", applyPolicy: { effective: "unlock_required", source: "local", manifestSaid: "auto" } } : { ok: true }, stdout: "{}", stderr: "", durationMs: 1200 }; },
    startedAt: "2026-09-18T10:00:00Z", sdk: "agent-sdk-ts/test", invocations: 0, coldStart: true,
    observed: async (fn) => ({ result: await fn(), error: undefined, observations: [] }),
    writeStatus: async () => undefined,
    nudge: async () => ({ messageId: null }),
  };
  return host;
}

const event = (method: string, rawPath: string, body?: unknown): APIGatewayProxyEventV2WithJWTAuthorizer => ({ version: "2.0", routeKey: "$default", rawPath, rawQueryString: "", headers: {}, requestContext: { accountId: "1", apiId: "a", domainName: "d", domainPrefix: "d", http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "1.1.1.1", userAgent: "t" }, requestId: "r", routeKey: "$default", stage: "$default", time: "", timeEpoch: 0, authorizer: { principalId: "p", integrationLatency: 0, jwt: { claims: { email: "seth@zudocs.com" }, scopes: [] } } }, isBase64Encoded: false, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) } as any);
const parse = (r: any) => ({ status: r.statusCode as number, body: JSON.parse(r.body) as any });

test("handler: a frozen host refuses a run with the SDK's reason, takes no cap slot, and /state says frozen", async () => {
  const host = fakeHost({ frozen: true });
  const handler = createHandler(async () => host);
  const run = parse(await handler(event("POST", "/tickets/T-1/run")));
  assert.equal(run.status, 423);
  assert.equal(run.body.error, "frozen");
  assert.match(run.body.message, /disabled: frozen from the console/);
  assert.equal(host.store.used, 0, "the cap is not taken for a refused run");
  assert.equal(host.store.events[0]?.kind, "run_refused");
  const state = parse(await handler(event("GET", "/state")));
  assert.deepEqual(state.body.frozen, { frozen: true, reason: "disabled: frozen from the console" });
  assert.deepEqual(state.body.features, { wire: true, nudge: false, hosted: false, hostCli: true });
  assert.deepEqual(frozenOf(fakeHost()), { frozen: false, reason: null });
});

test("handler: host_cli takes the allowlist only, policy goes through setApplyPolicy, golden reports counts, reset clears", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const bad = parse(await handler(event("POST", "/presenter/host_cli", { command: "policy set auto && cat /etc/passwd" })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "no_such_command");
  const show = parse(await handler(event("POST", "/presenter/host_cli", { command: "policy show" })));
  assert.equal(show.status, 200);
  assert.equal(show.body.summary, "in force unlock_required (local); the console says auto — advisory here");
  assert.equal(host.store.events.at(-1)?.kind, "host_cli");
  assert.equal(host.store.events.at(-1)?.forHost, "eu-west-1/ec2");
  assert.deepEqual(host.calls, ["host_cli:policy show"]);
  const policy = parse(await handler(event("POST", "/presenter/policy", { value: "auto" })));
  assert.equal(policy.status, 200);
  assert.match(policy.body.message, /already auto/);
  assert.equal(host.calls.at(-1), "setApplyPolicy:auto:seth@zudocs.com");
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
