/**
 * The handler over a fake host: a bare HTTP API event (raw path, no pathParameters) reaches the right route; the
 * daily cap refuses with 429 before any model is touched and never simulates; a run record carries only what the
 * fake SDK rendered and observed; feedback goes through `ap.feedback` and is stored with its verdict; a start
 * failure answers 503 with the code and is retried next time.
 *
 * @example
 * ```sh
 * npx tsx --test test/handler.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { createHandler } from "../src/handler.js";
import type { Host } from "../src/runtime.js";
import type { ApprovalRow, Customer, Store, StatusRow, Ticket, TimelineEvent } from "../src/store.js";

function fakeStore(): Store & { runs: Map<string, any>; events: TimelineEvent[]; status: StatusRow[]; feedback: any[]; used: number; queues: Map<string, string[]>; approvals: Map<string, ApprovalRow> } {
  const customers: Customer[] = [{ customerId: "cust-3003", name: "Orbital Bank", tier: "enterprise", seats: 240, since: "2024-11-20" }];
  const tickets: Ticket[] = [{ ticketId: "T-1", customerId: "cust-3003", subject: "s", body: "the ticket text", receivedAt: "2026-09-18T09:05:00Z", channel: "email", lastRun: null }];
  const self = {
    runs: new Map<string, any>(),
    events: [] as TimelineEvent[],
    status: [] as StatusRow[],
    feedback: [] as any[],
    used: 0,
    listCustomers: async () => customers,
    getCustomer: async (id: string) => customers.find((c) => c.customerId === id) ?? null,
    listTickets: async () => tickets,
    getTicket: async (id: string) => tickets.find((t) => t.ticketId === id) ?? null,
    putRun: async (run: any) => void self.runs.set(run.runId, run),
    getRun: async (id: string) => self.runs.get(id) ?? null,
    listRunsForTicket: async () => [...self.runs.values()],
    updateTicketLastRun: async (id: string, lastRun: any) => void (tickets.find((t) => t.ticketId === id)!.lastRun = lastRun),
    putFeedback: async (row: any) => void self.feedback.push(row),
    listFeedback: async () => self.feedback,
    putStatus: async (row: StatusRow) => void self.status.push(row),
    updateStatus: async () => undefined,
    listStatus: async () => self.status,
    appendEvent: async (event: TimelineEvent) => void self.events.push(event),
    listEvents: async () => self.events,
    takeRunSlot: async (_day: string, cap: number) => (self.used < cap ? { ok: true as const, used: ++self.used } : { ok: false as const, used: self.used }),
    readRunSlots: async () => self.used,
    seed: async (c: Customer[], t: Ticket[]) => ({ customers: c.length, tickets: t.length }),
    enqueueTicket: async (hostId: string, ticketId: string) => { const q = self.queues.get(hostId) ?? []; q.push(ticketId); self.queues.set(hostId, q); return q.length; },
    dequeueTicket: async (hostId: string) => self.queues.get(hostId)?.shift() ?? null,
    openApproval: async (row: ApprovalRow) => { if (self.approvals.has(row.approvalId)) return { created: false }; self.approvals.set(row.approvalId, { ...row }); return { created: true }; },
    getApproval: async (id: string) => self.approvals.get(id) ?? null,
    listApprovals: async () => [...self.approvals.values()],
    approve: async (id: string, by: string, at: string) => { const row = self.approvals.get(id); if (!row) return { ok: false, row: null }; if (row.decision !== "pending") return { ok: false, row }; Object.assign(row, { decision: "approved", decidedBy: by, decidedAt: at, updatedAt: at }); return { ok: true, row }; },
    settleApproval: async (id: string, settle: any) => { const row = self.approvals.get(id); if (!row || !["pending", "approved"].includes(row.decision)) return null; Object.assign(row, { decision: settle.decision, outcome: settle.outcome, activatedAt: settle.activatedAt ?? null, updatedAt: settle.at }); return row; },
    listRuns: async () => [...self.runs.values()],
    listAllFeedback: async () => self.feedback,
    reset: async (c: Customer[], t: Ticket[]) => { const counts = { runs: self.runs.size, feedback: self.feedback.length, approvals: self.approvals.size, events: self.events.length, counters: self.used ? 1 : 0, customers: c.length, tickets: t.length }; self.runs.clear(); self.feedback.length = 0; self.approvals.clear(); self.events.length = 0; self.used = 0; return counts; },
    queues: new Map<string, string[]>(),
    approvals: new Map<string, ApprovalRow>(),
  };
  return self;
}

/** Enough of the SDK: renders with the desk's source consulted, observes what the callers do, judges, files feedback. */
function fakeAp(store: Store, calls: string[]) {
  const state = { generation: 1, foreign: new Set<string>(), minted: 0, versionId: "rev-2", arm: "none", renders: [] as Array<{ tag: string; subject: string | undefined; values: Record<string, string> }>, frozen: false, policy: "auto", policySource: "local", ramps: [] as unknown[] };
  const status = () => ({ generation: state.generation, applyState: "active", variables: { sources: ["customer_tier"], unsourced: [] }, heartbeat: { lastAt: null, nextAt: null, intervalSeconds: 60, lastRefusal: null }, storageProtection: "kms", source: "store", applyPolicy: { effective: state.policy, source: state.policySource, manifestSaid: "auto" }, lastSyncOutcome: "unchanged", stagedGeneration: null, disabled: { agent: state.frozen, slots: [], arms: [] }, lastRefusal: state.frozen ? "disabled: frozen from the console" : null, ramps: state.ramps });
  const declared: Record<string, any[]> = {
    "support.triage": [{ name: "ticket", required: true, trust: "end_user" }],
    "support.reply": [{ name: "tone", required: false, trust: "operator", default: "friendly" }, { name: "customer_tier", required: true, trust: "operator", source: "runtime" }, { name: "ticket", required: true, trust: "end_user" }],
  };
  return {
    instanceId: "i-fake",
    generation: 1,
    status,
    healthz: () => ({ ok: true, status: "ok", reasons: [] }),
    prompt: (tag: string, { subject }: { subject?: string }) => ({
      variables: () => declared[tag] ?? [],
      renderAsync: async (values: Record<string, string>) => {
        state.renders.push({ tag, subject, values });
        const tier = subject ? (await store.getCustomer(subject))?.tier : undefined;
        const text = `${tag}: tone=${values.tone ?? "friendly"} tier=${tier} <ticket>${values.ticket}</ticket>`;
        state.minted += 1;
        return { text, model: tag === "support.triage" ? "amazon.nova-micro" : "openai.gpt-5-6-luna", versionId: state.versionId, arm: state.arm, generation: state.generation, runRef: `ref-${tag}-${state.minted}`, tag, inference: { maxOutputTokens: 600 } };
      },
    }),
    checks: (_r: unknown, output: string) => ({ passed: 1, failed: 0, results: [{ name: "signed", kind: "must_match", verdict: output.includes("team") ? "pass" : "fail" }] }),
    judge: async (_runRef: string, _output: string, _rubric: string, invoke: (p: string) => Promise<string>) => {
      await invoke("judge prompt");
      return { score: 0.75, taskPass: 3, taskFail: 1, taskUnclear: 0, protectionFail: 0, flagged: false };
    },
    // A reference minted by this "container" parses; one another container minted (marked foreign) does not.
    feedback: (runRef: string, signals: Record<string, unknown>) => {
      calls.push(`feedback:${runRef}:${Object.keys(signals).join(",")}`);
      return !state.foreign.has(runRef);
    },
    state,
    invoke: async <T>(fn: () => Promise<T>) => {
      calls.push("invoke");
      return fn();
    },
    heartbeatNow: async () => void calls.push("heartbeat"),
    syncNow: async () => void calls.push("sync"),
    flushTelemetry: async () => ({ status: "nothing" as const }),
    uploadNow: async () => null,
    spool: { observe: () => {} },
    onChange: () => () => {},
    setApplyPolicy: async (value: string) => { state.policy = value; state.policySource = "operator"; return { effective: value, source: "operator", manifestSaid: "auto" }; },
    golden: async () => [{ tag: "support.triage", arm: "control", setId: "gs", model: "amazon.nova-micro", cases: 5, passed: 4, failed: 1, passBps: 8000, minPassBps: 8000, meetsThreshold: true, results: [{ caseId: "a", ok: true, failed: [] }, { caseId: "b", ok: false, failed: ["category"] }] }],
  };
}

function fakeHost(): Host & { store: ReturnType<typeof fakeStore>; calls: string[] } {
  const store = fakeStore();
  const calls: string[] = [];
  const ap = fakeAp(store, calls) as unknown as Host["ap"];
  const env = { tables: {} as any, kmsKeyId: "k", agentKeyParameter: "/p", wireFunctionArn: "", nudgeQueueUrl: "", powerFunctionArn: "", demoModeParameter: "", hosted: { runKeyParameter: "", runUrl: "", target: "staging" }, euHost: { region: "eu-west-1", nameTag: "zudocs-eu-host" }, airprompter: { baseUrl: "https://api-dev.airprompter.com", organizationId: "o", agentId: "a", environment: "dev", hostedEnvironment: "dev", rootUrl: "u", rootJwk: "{}" }, dailyRunCap: 2, stateEpoch: "1", stateDir: "/tmp/airprompter/1", hostId: "us-east-1/lambda", region: "us-east-1", emfNamespace: "Zudocs/Desk", functionName: "", heartbeatSeconds: 60 } as Host["env"];
  const host: Host & { store: ReturnType<typeof fakeStore>; calls: string[] } = {
    env,
    ap,
    store,
    calls,
    callers: {
      judgeModel: "amazon.nova-micro",
      complete: async (rendered) => {
        calls.push(`model:${rendered.model}`);
        return { text: rendered.model === "amazon.nova-micro" ? '{"category":"publishing","priority":"urgent","summary":"site down"}' : "Thanks — the team", response: {} };
      },
      judge: async () => "PASS PASS PASS FAIL",
      golden: async () => ({ text: "{}", outputTokens: 2 }),
    },
    hosted: null,
    hostCli: async (command) => { calls.push(`host_cli:${command}`); return { command, line: `zudocs-cli ${command} --json`, status: "Success" as const, instanceId: "i-eu", document: command === "policy show" ? { via: "daemon", applyPolicy: { effective: "unlock_required", source: "local", manifestSaid: "auto" } } : command === "rollback" ? { generation: 3, forced: true, outcome: "rolled_back" } : { ok: true }, stdout: "{}", stderr: "", durationMs: 1200 }; },
    startedAt: "2026-09-18T10:00:00Z",
    sdk: "agent-sdk-ts/test",
    invocations: 0,
    coldStart: true,
    observed: async (fn) => ({ result: await fn(), error: undefined, observations: [{ tag: "support.reply", versionId: "rev-2", arm: "none", model: "openai.gpt-5-6-luna", status: "ok", latencyMs: 1234, tokens: { input: 200, output: 40 }, usageSource: "reported" }] }),
    writeStatus: async () => store.putStatus({ hostId: "us-east-1/lambda", region: "us-east-1", kind: "lambda", sdk: "x", writtenAt: "", status: ap.status(), healthz: ap.healthz(), container: { instanceId: "i-fake", coldStart: false, startedAt: "", invocations: 1 } }),
    nudge: async (body) => { calls.push(`nudge:${String(body.by)}`); return { messageId: "msg-1" }; },
    power: async (action, by) => { calls.push(`power:${action}:${by}`); return { action, hostId: "eu-west-1/ec2", instanceId: "i-eu", state: action === "sleep" ? "stopping" : action === "wake" ? "pending" : "running", changed: action !== "tick", refusal: null, marker: { state: action === "sleep" ? "stopping" : action === "wake" ? "pending" : "running", since: "2026-09-21T10:00:00.000Z", at: "2026-09-21T10:00:00.000Z", by, instanceId: "i-eu" }, message: `${action} done` }; },
    demoMode: null,
  };
  return host;
}

const event = (method: string, rawPath: string, body?: unknown): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({ version: "2.0", routeKey: `${method} ${rawPath}`, rawPath, rawQueryString: "", headers: {}, requestContext: { http: { method, path: rawPath }, authorizer: { jwt: { claims: { email: "seth@zudocs.com" }, scopes: [] } } }, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false, pathParameters: undefined }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const parse = (result: unknown) => JSON.parse((result as { body: string }).body);

test("a run: routed on the raw path, inside invoke(), the record carries the SDK's render, observation, checks and judge; the inbox learns the headline", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const result = await handler(event("POST", "/tickets/T-1/run"));
  assert.equal((result as { statusCode: number }).statusCode, 200);
  const { run, cap } = parse(result);
  assert.deepEqual(cap, { used: 1, cap: 2, day: new Date().toISOString().slice(0, 10) });
  assert.deepEqual(host.calls.filter((c) => c !== "invoke"), ["model:amazon.nova-micro", "model:openai.gpt-5-6-luna"], "two model calls, the judge through the callers");
  assert.ok(host.calls.includes("invoke"), "ran inside ap.invoke()");
  assert.deepEqual(run.triage, { category: "publishing", priority: "urgent", summary: "site down" });
  const reply = run.steps.find((s: any) => s.step === "reply");
  assert.equal(reply.versionId, "rev-2");
  assert.equal(reply.model, "openai.gpt-5-6-luna");
  assert.equal(reply.observation.latencyMs, 1234, "the SDK's observation, not a stopwatch");
  assert.equal(reply.judge.score, 0.75);
  assert.equal(reply.checks[0].verdict, "pass");
  assert.deepEqual(reply.rendered.variables.map((v: any) => [v.name, v.origin, v.value]), [["tone", "call_site", "formal"], ["customer_tier", "your_source", "enterprise"], ["ticket", "call_site", "the ticket text"]], "an enterprise customer gets tone: formal from the call site; the tier from the desk's source");
  assert.ok(reply.rendered.text.includes("<ticket>the ticket text</ticket>"));
  assert.equal(reply.costUsd, (200 * 0.2 + 40 * 1.2) / 1_000_000);
  assert.equal((await host.store.getTicket("T-1"))!.lastRun!.category, "publishing");
  assert.equal(host.store.status.length, 1, "the status row was written after the run");
  assert.deepEqual(host.store.events.map((e) => e.kind), ["ticket_run"]);
});

test("the cap: the third run of a two-run day is refused with 429 and its reason, no model touched, an event written", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  await handler(event("POST", "/tickets/T-1/run"));
  await handler(event("POST", "/tickets/T-1/run"));
  const before = host.calls.length;
  const refused = await handler(event("POST", "/tickets/T-1/run"));
  assert.equal((refused as { statusCode: number }).statusCode, 429);
  const body = parse(refused);
  assert.equal(body.error, "daily_cap");
  assert.equal(body.used, 2);
  assert.match(body.message, /Nothing was simulated/);
  assert.deepEqual(host.calls.slice(before).filter((c) => c !== "invoke"), [], "no model call (the invoke runs for its sync pass, then the cap refuses)");
  const refusal = host.store.events.at(-1)!;
  assert.equal(refusal.kind, "cap_refused");
  assert.equal(refusal.capDay, body.day, "the day rides as capDay: `day` is the events table's partition key and never comes back to the timeline");
  assert.ok(!("day" in refusal));
});

test("approvals: listed with the pending count; approved exactly once by the signed-in owner with an event; a repeat answers 200 with the row as it stands and no second event; unknown ids 404", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const row: ApprovalRow = { approvalId: "eu-west-1-ec2-g2", hostId: "eu-west-1/ec2", storeId: "i-store", generation: 2, releaseDigest: null, stagedAt: "2026-09-18T15:00:00.000Z", unlockRequest: null, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: "2026-09-18T15:00:00.000Z" };
  await host.store.openApproval(row);
  const listed = parse(await handler(event("GET", "/approvals")));
  assert.equal(listed.pending, 1);
  assert.equal(listed.approvals[0].approvalId, "eu-west-1-ec2-g2");
  const first = parse(await handler(event("POST", "/approvals/eu-west-1-ec2-g2/approve")));
  assert.equal(first.already, false);
  assert.equal(first.approval.decision, "approved");
  assert.equal(first.approval.decidedBy, "seth@zudocs.com", "the JWT's e-mail, not a body field");
  assert.match(first.message, /release #2 approved for eu-west-1\/ec2/);
  const second = parse(await handler(event("POST", "/approvals/eu-west-1-ec2-g2/approve")));
  assert.equal(second.already, true);
  assert.equal(second.approval.decidedBy, "seth@zudocs.com");
  assert.match(second.message, /already approved/);
  assert.deepEqual(host.store.events.filter((e) => e.kind === "approval_decided").length, 1, "one decision, one event");
  assert.equal((await handler(event("POST", "/approvals/nope/approve")) as { statusCode: number }).statusCode, 404);
  assert.equal(parse(await handler(event("GET", "/approvals"))).pending, 0);
});

test("the presenter's enqueue puts a ticket on another host's queue (never this host's) and the wire buttons are refused until the eu-west stack exists", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const queued = await handler(event("POST", "/presenter/enqueue", { ticketId: "T-1", host: "eu-west-1/ec2" }));
  assert.equal((queued as { statusCode: number }).statusCode, 202);
  assert.deepEqual(host.store.queues.get("eu-west-1/ec2"), ["T-1"]);
  assert.equal(parse(queued).depth, 1);
  assert.equal((await handler(event("POST", "/presenter/enqueue", { ticketId: "T-1", host: "us-east-1/lambda" })) as { statusCode: number }).statusCode, 400, "this host runs on request, it has no queue");
  assert.equal((await handler(event("POST", "/presenter/enqueue", { ticketId: "T-9", host: "eu-west-1/ec2" })) as { statusCode: number }).statusCode, 404);
  const cut = await handler(event("POST", "/presenter/cut_wire"));
  assert.equal((cut as { statusCode: number }).statusCode, 501);
  assert.equal(parse(cut).error, "no_wire_function");
  assert.equal(host.store.events.filter((e) => e.kind === "wire").length, 0, "nothing was cut, nothing is on the timeline");
});

test("feedback goes through ap.feedback against the reply's run reference; undeclared signals are refused before anything is filed", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const { run } = parse(await handler(event("POST", "/tickets/T-1/run")));
  const ok = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "up" } }));
  assert.equal((ok as { statusCode: number }).statusCode, 200);
  assert.equal(parse(ok).container, "same");
  assert.ok(host.calls.includes("feedback:ref-support.reply-2:thumbs"), "the reply's own reference (the second render of the run)");
  const refused = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { mood: "great" } }));
  assert.equal((refused as { statusCode: number }).statusCode, 422, "the SDK's vocabulary is the answer");
  assert.deepEqual(parse(refused).rejected, { mood: "unknown_signal" });
  assert.equal(host.store.feedback.length, 1, "a refused signal is not stored as feedback");
  assert.equal((await handler(event("POST", "/runs/run_nope/feedback", { signals: { thumbs: "up" } })) as { statusCode: number }).statusCode, 404);
});

test("feedback across containers: a reference this container cannot parse is re-derived by rendering the same slot for the same customer with the record's call-site values; refused when the version or the arm moved; mixed signals keep the accepted ones", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const { run } = parse(await handler(event("POST", "/tickets/T-1/run")));
  const reply = run.steps.find((s: any) => s.step === "reply");
  const ap = host.ap as unknown as { state: { generation: number; foreign: Set<string>; versionId: string; arm: string; renders: Array<{ tag: string; subject: string | undefined; values: Record<string, string> }> } };
  ap.state.foreign.add(reply.runRef);
  const before = ap.state.renders.length;
  const filed = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { accepted: true, mood: "great" } }));
  assert.equal((filed as { statusCode: number }).statusCode, 200);
  assert.equal(parse(filed).container, "re-rendered");
  assert.deepEqual(parse(filed).signals, { accepted: true }, "the refused name is dropped, the accepted signal filed");
  assert.deepEqual(ap.state.renders.slice(before), [{ tag: "support.reply", subject: "cust-3003", values: { tone: "formal", ticket: "the ticket text" } }], "the same slot, the same customer, the record's own call-site values (tone: formal for the enterprise customer; the ticket)");
  assert.ok(host.calls.includes("feedback:ref-support.reply-3:accepted"), "filed against a reference minted here");
  assert.deepEqual(host.store.feedback.at(-1)!.signals, { accepted: true });
  assert.deepEqual(host.store.events.at(-1)!.signals, ["accepted"]);
  ap.state.generation = 2;
  const newRelease = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "down" } }));
  assert.equal((newRelease as { statusCode: number }).statusCode, 200, "a newer release with the same version and arm still files: the window's facts are unchanged");
  ap.state.versionId = "rev-3";
  const movedVersion = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "down" } }));
  assert.equal((movedVersion as { statusCode: number }).statusCode, 409, "a newer prompt version here: feedback would land on the wrong version");
  assert.equal(parse(movedVersion).error, "run_reference_foreign");
  assert.match(parse(movedVersion).message, /rev-3/);
  assert.equal(host.store.feedback.at(-1)!.filed, false, "stored as not filed, so the desk shows it honestly");
  ap.state.versionId = "rev-2";
  ap.state.arm = "candidate";
  const movedArm = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "down" } }));
  assert.equal((movedArm as { statusCode: number }).statusCode, 409, "another arm here: refused");
  assert.match(parse(movedArm).message, /arm candidate/);
});

test("feedback across containers: a record with no render, or a render that throws here, is refused with the reason", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const { run } = parse(await handler(event("POST", "/tickets/T-1/run")));
  const stored = await host.store.getRun(run.runId);
  const reply = (stored!.steps as any[]).find((s: any) => s.step === "reply");
  const ap = host.ap as unknown as { state: { foreign: Set<string> }; prompt: unknown };
  ap.state.foreign.add(reply.runRef);
  const originalPrompt = ap.prompt;
  ap.prompt = () => { throw Object.assign(new Error("render support.reply: refused (disabled) on generation 1"), { name: "RenderRefusedError" }); };
  const thrown = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "up" } }));
  assert.equal((thrown as { statusCode: number }).statusCode, 409);
  assert.match(parse(thrown).message, /could not be re-derived here: render support.reply: refused/);
  ap.prompt = originalPrompt;
  reply.rendered = null;
  const bare = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "up" } }));
  assert.equal((bare as { statusCode: number }).statusCode, 409);
  assert.match(parse(bare).message, /carries no render/);
});

test("state, events, healthz and unknown routes; a failed start answers 503 with the code", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const state = parse(await handler(event("GET", "/state")));
  assert.equal(state.host.status.storageProtection, "kms");
  assert.deepEqual(state.host.models, ["openai.gpt-5-6-luna", "amazon.nova-2-lite", "amazon.nova-micro", "anthropic.claude-haiku-4-5"]);
  assert.deepEqual(state.cap, { day: new Date().toISOString().slice(0, 10), used: 0, cap: 2 });
  assert.deepEqual(state.features, { wire: false, nudge: false, hosted: false, hostCli: false, power: false, demoMode: false }, "no wire function, no nudge queue, no run key configured on this fake host");
  const nudge = await handler(event("POST", "/presenter/nudge"));
  assert.equal((nudge as { statusCode: number }).statusCode, 501, "without the fleet stack there is nothing to nudge, and it says so");
  assert.equal(parse(nudge).error, "no_nudge_queue");
  (host.env as { nudgeQueueUrl: string }).nudgeQueueUrl = "https://sqs.ap-southeast-1.amazonaws.com/111122223333/zudocs-nudge";
  const nudged = parse(await handler(event("POST", "/presenter/nudge")));
  assert.equal(nudged.messageId, "msg-1");
  assert.ok(host.calls.includes("nudge:seth@zudocs.com"), "one message on the queue, signed by the presenter");
  assert.equal(host.store.events.at(-1)!.kind, "presenter");
  assert.equal(host.store.events.at(-1)!.action, "nudge");
  assert.equal((await handler(event("GET", "/healthz")) as { statusCode: number }).statusCode, 200);
  assert.equal((await handler(event("GET", "/nope")) as { statusCode: number }).statusCode, 404);
  assert.equal((await handler(event("POST", "/presenter/dance")) as { statusCode: number }).statusCode, 404);
  const heartbeat = parse(await handler(event("POST", "/presenter/heartbeat")));
  assert.equal(heartbeat.action, "heartbeat");
  assert.ok(host.calls.includes("heartbeat"));
  let attempts = 0;
  const failing = createHandler(async () => {
    attempts += 1;
    throw Object.assign(new Error("no verified release in the store"), { name: "AgentStartError", code: "no_verified_release" });
  });
  const down = await failing(event("GET", "/state"));
  assert.equal((down as { statusCode: number }).statusCode, 503);
  assert.equal(parse(down).code, "no_verified_release");
  await failing(event("GET", "/state"));
  assert.equal(attempts, 2, "the provider is asked again on the next request");
});

test("a refused model call: the step keeps the SDK's error observation and the provider's message, the run answers 502 with ok=false, nothing is simulated", async () => {
  const host = fakeHost();
  (host as { callers: Host["callers"] }).callers = { ...host.callers, complete: async (rendered: { model: string }) => { if (rendered.model === "openai.gpt-5-6-luna") throw Object.assign(new Error("401 openai.gpt-5.6-luna is not available for this account"), { name: "AuthenticationError" }); return { text: '{"category":"billing","priority":"low","summary":"x"}', response: {} }; } };
  host.observed = async (fn) => {
    try { return { result: await fn(), error: undefined, observations: [{ tag: "support.triage", versionId: "rev-2", arm: "none", model: "amazon.nova-micro", status: "ok", latencyMs: 300, tokens: { input: 10, output: 5 }, usageSource: "reported" }] }; }
    catch (error) { return { result: undefined, error, observations: [{ tag: "support.reply", versionId: "rev-2", arm: "none", model: "openai.gpt-5-6-luna", status: "error", errorClass: "provider_error", latencyMs: 120, usageSource: "unavailable" }] }; }
  };
  const handler = createHandler(async () => host);
  const result = await handler(event("POST", "/tickets/T-1/run"));
  assert.equal((result as { statusCode: number }).statusCode, 502);
  const { run } = parse(result);
  assert.equal(run.ok, false);
  const reply = run.steps.find((s: any) => s.step === "reply");
  assert.equal(reply.output, null, "no answer was invented");
  assert.equal(reply.error.name, "AuthenticationError");
  assert.equal(reply.observation.status, "error");
  assert.equal(reply.observation.errorClass, "provider_error", "the SDK's classification rides along");
  assert.deepEqual(reply.checks, []);
  assert.equal(reply.judge, null);
  assert.equal(run.triage.category, "billing", "the step before it still answered");
});

test("the status tick from EventBridge is a sync pass and one status row: no request is answered, nothing runs, the host that failed to start answers nothing", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const before = host.store.status.length;
  const out = await handler({ tick: "status" } as never);
  assert.equal(out, undefined, "not an HTTP answer");
  assert.ok(host.calls.includes("invoke"), "a sync pass inside invoke()");
  assert.equal(host.store.status.length, before + 1, "one row");
  assert.equal(host.store.runs.size, 0, "nothing ran");
  let attempts = 0;
  const failing = createHandler(async () => { attempts += 1; throw Object.assign(new Error("no parameter"), { code: "kek_unavailable" }); });
  assert.equal(await failing({ tick: "status" } as never), undefined, "a failed start on a tick answers nothing and does not throw");
  assert.equal(attempts, 1);
});
