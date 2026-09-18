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
import type { Customer, Store, StatusRow, Ticket, TimelineEvent } from "../src/store.js";

function fakeStore(): Store & { runs: Map<string, any>; events: TimelineEvent[]; status: StatusRow[]; feedback: any[]; used: number } {
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
    listStatus: async () => self.status,
    appendEvent: async (event: TimelineEvent) => void self.events.push(event),
    listEvents: async () => self.events,
    takeRunSlot: async (_day: string, cap: number) => (self.used < cap ? { ok: true as const, used: ++self.used } : { ok: false as const, used: self.used }),
    readRunSlots: async () => self.used,
    seed: async (c: Customer[], t: Ticket[]) => ({ customers: c.length, tickets: t.length }),
  };
  return self;
}

/** Enough of the SDK: renders with the desk's source consulted, observes what the callers do, judges, files feedback. */
function fakeAp(store: Store, calls: string[]) {
  const status = () => ({ generation: 1, applyState: "active", variables: { sources: ["customer_tier"], unsourced: [] }, heartbeat: { lastAt: null, nextAt: null, intervalSeconds: 60, lastRefusal: null }, storageProtection: "kms", source: "store", applyPolicy: { effective: "auto", source: "local", manifestSaid: "auto" }, lastSyncOutcome: "unchanged", stagedGeneration: null });
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
        const tier = subject ? (await store.getCustomer(subject))?.tier : undefined;
        const text = `${tag}: tone=${values.tone ?? "friendly"} tier=${tier} <ticket>${values.ticket}</ticket>`;
        return { text, model: tag === "support.triage" ? "amazon.nova-micro" : "openai.gpt-5-6-luna", versionId: "rev-2", arm: "none", generation: 1, runRef: `ref-${tag}`, tag, inference: { maxOutputTokens: 600 } };
      },
    }),
    checks: (_r: unknown, output: string) => ({ passed: 1, failed: 0, results: [{ name: "signed", kind: "must_match", verdict: output.includes("team") ? "pass" : "fail" }] }),
    judge: async (_runRef: string, _output: string, _rubric: string, invoke: (p: string) => Promise<string>) => {
      await invoke("judge prompt");
      return { score: 0.75, taskPass: 3, taskFail: 1, taskUnclear: 0, protectionFail: 0, flagged: false };
    },
    feedback: (runRef: string, signals: Record<string, unknown>) => {
      calls.push(`feedback:${runRef}:${Object.keys(signals).join(",")}`);
      return "thumbs" in signals;
    },
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
  };
}

function fakeHost(): Host & { store: ReturnType<typeof fakeStore>; calls: string[] } {
  const store = fakeStore();
  const calls: string[] = [];
  const ap = fakeAp(store, calls) as unknown as Host["ap"];
  const env = { tables: {} as any, kmsKeyId: "k", agentKeyParameter: "/p", airprompter: { baseUrl: "https://api-dev.airprompter.com", organizationId: "o", agentId: "a", environment: "dev", hostedEnvironment: "dev", rootUrl: "u", rootJwk: "{}" }, dailyRunCap: 2, stateEpoch: "1", stateDir: "/tmp/airprompter/1", hostId: "us-east-1/lambda", region: "us-east-1", emfNamespace: "Zudocs/Desk", functionName: "", heartbeatSeconds: 60 } as Host["env"];
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
    },
    startedAt: "2026-09-18T10:00:00Z",
    sdk: "agent-sdk-ts/test",
    invocations: 0,
    coldStart: true,
    observed: async (fn) => ({ result: await fn(), observations: [{ tag: "support.reply", versionId: "rev-2", arm: "none", model: "openai.gpt-5-6-luna", status: "ok", latencyMs: 1234, tokens: { input: 200, output: 40 }, usageSource: "reported" }] }),
    writeStatus: async () => store.putStatus({ hostId: "us-east-1/lambda", region: "us-east-1", kind: "lambda", sdk: "x", writtenAt: "", status: ap.status(), healthz: ap.healthz(), container: { instanceId: "i-fake", coldStart: false, startedAt: "", invocations: 1 } }),
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
  assert.equal(host.calls.length, before, "no invoke, no model call");
  assert.equal(host.store.events.at(-1)!.kind, "cap_refused");
});

test("feedback goes through ap.feedback against the reply's run reference and is stored with the SDK's verdict", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const { run } = parse(await handler(event("POST", "/tickets/T-1/run")));
  const ok = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { thumbs: "up" } }));
  assert.equal((ok as { statusCode: number }).statusCode, 200);
  assert.ok(host.calls.includes("feedback:ref-support.reply:thumbs"));
  const refused = await handler(event("POST", `/runs/${run.runId}/feedback`, { signals: { mood: "great" } }));
  assert.equal((refused as { statusCode: number }).statusCode, 422, "the SDK's refusal is the answer");
  assert.equal(host.store.feedback.length, 2);
  assert.deepEqual(host.store.feedback.map((f) => f.filed), [true, false]);
  assert.equal((await handler(event("POST", "/runs/run_nope/feedback", { signals: { thumbs: "up" } })) as { statusCode: number }).statusCode, 404);
});

test("state, events, healthz and unknown routes; a failed start answers 503 with the code", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const state = parse(await handler(event("GET", "/state")));
  assert.equal(state.host.status.storageProtection, "kms");
  assert.deepEqual(state.host.models, ["openai.gpt-5-6-luna", "amazon.nova-micro", "anthropic.claude-haiku-4-5"]);
  assert.deepEqual(state.cap, { day: new Date().toISOString().slice(0, 10), used: 0, cap: 2 });
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
