/**
 * Phase 8 units: the demo-mode document's fail-closed rules (no expiry, a lapsed or overlong instant, an unknown
 * mode and an unreadable text all read as off, with the reason; the desk's document carries a four-hour expiry);
 * the card's power view (asleep since, going to sleep, waking, started-but-not-reporting, awake once a row is newer
 * than the start) and when a poll asks the function to look; and the handler's new paths — `sleep_host` and
 * `wake_host` through the power port (its answer back, a refusal as 409 on the timeline, 501 without the function),
 * `demo_mode` through the switch port (on/off only, the event, 501 without a parameter), `host_cli` refused while the
 * host is asleep, `/state` carrying the eu-west row's power view and asking the function to look while a marker is
 * in transition past its grace.
 *
 * @example
 * ```sh
 * npx tsx --test test/phase8.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { DEMO_MODE_MAX_HOURS, demoModeDocument, parseDemoMode } from "../src/demoMode.js";
import { createHandler } from "../src/handler.js";
import { RECONCILE_GIVE_UP_MINUTES, RECONCILE_GRACE_SECONDS, needsReconcile, powerView, type PowerAnswer, type PowerMarker } from "../src/hostPower.js";
import type { Host } from "../src/runtime.js";
import type { Customer, StatusRow, Store, Ticket, TimelineEvent } from "../src/store.js";

const NOW = Date.parse("2026-09-21T16:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("demo mode: on only with a document that says on and an expiry still ahead; everything else is off with its reason", () => {
  assert.deepEqual(parseDemoMode(`{"mode":"on","until":"${iso(3_600_000)}","by":"seth@zudocs.com"}`, NOW), { mode: "on", until: iso(3_600_000), by: "seth@zudocs.com", reason: null });
  assert.equal(parseDemoMode(`{"mode":"on","until":"${iso(-1)}"}`, NOW).reason, "expired");
  assert.equal(parseDemoMode(`{"mode":"on","until":"${iso(-1)}"}`, NOW).mode, "off");
  assert.equal(parseDemoMode('{"mode":"on"}', NOW).reason, "no_expiry", "a switch with no expiry is off: a forgotten session never runs the demo cadence for a week");
  assert.equal(parseDemoMode(`{"mode":"on","until":"${iso((DEMO_MODE_MAX_HOURS + 1) * 3_600_000)}"}`, NOW).reason, "too_long");
  assert.equal(parseDemoMode('{"mode":"maybe"}', NOW).reason, "unknown_mode");
  assert.equal(parseDemoMode("on", NOW).reason, "unparseable");
  assert.equal(parseDemoMode("[1]", NOW).reason, "unparseable");
  assert.equal(parseDemoMode(null, NOW).reason, "absent");
  assert.equal(parseDemoMode("", NOW).reason, "absent");
  assert.deepEqual(parseDemoMode('{"mode":"off","by":"x"}', NOW), { mode: "off", until: null, by: "x", reason: null });
  const on = JSON.parse(demoModeDocument("on", "seth@zudocs.com", NOW));
  assert.equal(on.until, iso(DEMO_MODE_MAX_HOURS * 3_600_000), "the desk writes a four-hour expiry");
  assert.equal(parseDemoMode(demoModeDocument("on", "seth@zudocs.com", NOW), NOW).mode, "on");
  assert.equal(parseDemoMode(demoModeDocument("on", "seth@zudocs.com", NOW), NOW + DEMO_MODE_MAX_HOURS * 3_600_000 + 1).reason, "expired");
  assert.equal(parseDemoMode(demoModeDocument("off", "seth@zudocs.com", NOW), NOW).mode, "off");
});

test("the card's power view: the marker and the row's age folded into a phase; a poll asks the function to look only in transition past the grace", () => {
  const marker = (state: PowerMarker["state"], sinceMs: number, atMs = sinceMs): PowerMarker => ({ state, since: iso(sinceMs), at: iso(atMs), by: "the nightly schedule", instanceId: "i-eu" });
  assert.deepEqual(powerView(null, iso(-5_000), NOW), { phase: "awake", since: null, by: null, label: "awake" });
  assert.equal(powerView(marker("stopping", -10_000), iso(-5_000), NOW).phase, "going_to_sleep", "stopping reads as going to sleep whatever the row's age (the workers write once more while the OS halts)");
  assert.deepEqual(powerView(marker("stopped", -3_600_000, -3_000_000), iso(-3_650_000), NOW), { phase: "asleep", since: iso(-3_600_000), by: "the nightly schedule", label: "asleep" }, "asleep since the sleep began, not since the tick found it stopped");
  assert.equal(powerView(marker("pending", -20_000), iso(-3_650_000), NOW).phase, "waking");
  assert.equal(powerView(marker("pending", -20_000), iso(-3_650_000), NOW).label, "waking");
  assert.equal(powerView(marker("pending", -900_000), iso(-3_650_000), NOW).label, "waking, longer than expected — see the timeline", "a transition ten minutes old is said, not left hanging");
  assert.equal(powerView(marker("stopping", -900_000), iso(-3_650_000), NOW).label, "going to sleep, longer than expected — see the timeline");
  assert.equal(powerView(marker("running", -120_000, -60_000), iso(-3_650_000), NOW).phase, "started", "running per EC2 but the workers' row predates the start");
  assert.equal(powerView(marker("running", -120_000, -60_000), iso(-3_650_000), NOW).label, "started, the workers are coming up");
  assert.equal(powerView(marker("running", -900_000, -800_000), iso(-3_650_000), NOW).label, "started, the workers have not reported", "ten minutes without a row is said, not hidden");
  assert.equal(powerView(marker("running", -120_000, -60_000), iso(-10_000), NOW).phase, "awake", "a row newer than the start: awake");
  assert.equal(needsReconcile(null, NOW), false);
  assert.equal(needsReconcile(marker("stopped", -3_600_000), NOW), false, "a settled marker needs nothing");
  assert.equal(needsReconcile(marker("running", -120_000), NOW), false);
  assert.equal(needsReconcile(marker("stopping", -5_000), NOW), false, "within the grace the function is left alone");
  assert.equal(needsReconcile(marker("stopping", -(RECONCILE_GRACE_SECONDS + 1) * 1000), NOW), true);
  assert.equal(needsReconcile(marker("pending", -60_000), NOW), true);
  assert.equal(needsReconcile(marker("pending", -(RECONCILE_GIVE_UP_MINUTES + 1) * 60_000), NOW), false, "half an hour in transition: the tick's problem, not every poll's (a replacement has no instance to reconcile with)");
});

// --- handler --------------------------------------------------------------------------------------------------------------

const customer: Customer = { customerId: "cust-1", name: "Orbital Bank", tier: "enterprise", seats: 40, since: "2025-01-01" };
const ticket: Ticket = { ticketId: "T-1", customerId: "cust-1", subject: "s", body: "b", receivedAt: "2026-09-18T09:00:00Z", channel: "email" };

function fakeStore(): Store & { events: TimelineEvent[]; status: StatusRow[] } {
  const self: any = {
    events: [] as TimelineEvent[], status: [] as StatusRow[], used: 0,
    listCustomers: async () => [customer], getCustomer: async () => customer, listTickets: async () => [ticket], getTicket: async () => ticket,
    putRun: async () => undefined, getRun: async () => null, listRunsForTicket: async () => [], updateTicketLastRun: async () => undefined, putFeedback: async () => undefined, listFeedback: async () => [],
    putStatus: async (row: StatusRow) => void self.status.push(row), updateStatus: async () => undefined, listStatus: async () => self.status,
    appendEvent: async (e: TimelineEvent) => void self.events.push(e), listEvents: async () => self.events,
    takeRunSlot: async () => ({ ok: true, used: ++self.used }), readRunSlots: async () => self.used,
    seed: async () => ({ customers: 1, tickets: 1 }), enqueueTicket: async () => 1, dequeueTicket: async () => null,
    openApproval: async () => ({ created: true }), getApproval: async () => null, listApprovals: async () => [], approve: async () => ({ ok: false, row: null }), settleApproval: async () => null,
    listRuns: async () => [], listAllFeedback: async () => [], reset: async () => ({ runs: 0, feedback: 0, approvals: 0, events: 0, counters: 0, customers: 1, tickets: 1 }),
  };
  return self;
}

function fakeHost(options: { power?: boolean; demoMode?: boolean; refusal?: string | null; throwOnPower?: boolean; euRow?: Partial<StatusRow> & { power?: PowerMarker }; now?: () => number } = {}) {
  const store = fakeStore();
  const calls: string[] = [];
  const status = () => ({ generation: 7, stagedGeneration: null, applyState: "active", variables: { sources: [], unsourced: [] }, heartbeat: { lastAt: null, nextAt: null, intervalSeconds: 60, lastRefusal: null }, storageProtection: "kms", source: "store", applyPolicy: { effective: "auto", source: "local", manifestSaid: "auto" }, lastSyncOutcome: "unchanged", disabled: { agent: false, slots: [], arms: [] }, lastRefusal: null, ramps: [] });
  const ap: any = { instanceId: "i-fake", generation: 7, status, healthz: () => ({ ok: true, status: "ok", reasons: [] }), invoke: async (fn: () => Promise<unknown>) => fn(), prompt: () => ({ variables: () => [] }), feedback: () => true, onChange: () => () => {} };
  const env = { tables: {} as any, kmsKeyId: "k", agentKeyParameter: "/p", wireFunctionArn: "arn:aws:lambda:eu-west-1:1:function:zudocs-wire", nudgeQueueUrl: "", powerFunctionArn: options.power === false ? "" : "arn:aws:lambda:eu-west-1:1:function:zudocs-power", demoModeParameter: options.demoMode === false ? "" : "/zudocs/dev/demo-mode", hosted: { runKeyParameter: "", runUrl: "", target: "staging" }, providers: { openai: { keyParameter: "", model: "gpt-5.6-luna" }, anthropic: { keyParameter: "", model: "claude-opus-5" } }, euHost: { region: "eu-west-1", nameTag: "zudocs-eu-host" }, airprompter: { baseUrl: "https://api-dev.airprompter.com", organizationId: "o", agentId: "a", environment: "dev", hostedEnvironment: "dev", rootUrl: "u", rootJwk: "{}" }, dailyRunCap: 2, stateEpoch: "1", stateDir: "/tmp/airprompter/1", hostId: "us-east-1/lambda", region: "us-east-1", emfNamespace: "Zudocs/Desk", functionName: "zudocs-desk-api", heartbeatSeconds: 60 } as Host["env"];
  if (options.euRow) store.status.push({ hostId: "eu-west-1/ec2", region: "eu-west-1", kind: "daemon", sdk: "x", writtenAt: iso(-60_000), status: {}, healthz: { ok: true, status: "ok", reasons: [] }, container: { instanceId: "d", coldStart: false, startedAt: "", invocations: 0 }, ...options.euRow } as StatusRow);
  let written: string | null = null;
  const host: Host & { store: ReturnType<typeof fakeStore>; calls: string[]; written: () => string | null } = {
    env, ap, store, calls, written: () => written, callers: { judgeModel: "amazon.nova-micro", complete: async () => ({ text: "", response: {} }), judge: async () => "", golden: async () => ({ text: "", outputTokens: null }) }, hosted: null,
    hostCli: async (command) => { calls.push(`host_cli:${command}`); return { command, line: "", status: "Success", instanceId: "i-eu", document: {}, stdout: "{}", stderr: "", durationMs: 1 }; },
    startedAt: "2026-09-18T10:00:00Z", sdk: "agent-sdk-ts/test", invocations: 0, coldStart: true,
    observed: async (fn) => ({ result: await fn(), error: undefined, observations: [] }),
    writeStatus: async () => undefined,
    nudge: async () => ({ messageId: null }),
    power: async (action, by): Promise<PowerAnswer> => {
      calls.push(`power:${action}:${by}`);
      if (options.throwOnPower) throw new Error("AccessDeniedException: not authorized to invoke");
      const state = action === "sleep" ? "stopping" : action === "wake" ? "pending" : "running";
      const marker: PowerMarker = { state, since: iso(0), at: iso(0), by, instanceId: "i-eu" };
      if (options.refusal) return { action, hostId: "eu-west-1/ec2", instanceId: "i-eu", state: "running", changed: false, refusal: options.refusal, marker: null, message: `refused: ${options.refusal}` };
      return { action, hostId: "eu-west-1/ec2", instanceId: "i-eu", state, changed: action !== "tick", refusal: null, marker, message: `${action} done` };
    },
    demoMode: options.demoMode === false ? null : {
      read: async () => ({ ...parseDemoMode(written, (options.now ?? Date.now)()), parameter: "/zudocs/dev/demo-mode" }),
      write: async (mode, by) => { written = demoModeDocument(mode, by, (options.now ?? Date.now)()); calls.push(`demo_mode:${mode}:${by}`); return { ...parseDemoMode(written, (options.now ?? Date.now)()), parameter: "/zudocs/dev/demo-mode" }; },
    },
  };
  return host;
}

const event = (method: string, rawPath: string, body?: unknown): APIGatewayProxyEventV2WithJWTAuthorizer => ({ version: "2.0", routeKey: "$default", rawPath, rawQueryString: "", headers: {}, requestContext: { accountId: "1", apiId: "a", domainName: "d", domainPrefix: "d", http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "1.1.1.1", userAgent: "t" }, requestId: "r", routeKey: "$default", stage: "$default", time: "", timeEpoch: 0, authorizer: { principalId: "p", integrationLatency: 0, jwt: { claims: { email: "seth@zudocs.com" }, scopes: [] } } }, isBase64Encoded: false, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) } as any);
const parse = (r: any) => ({ status: r.statusCode as number, body: JSON.parse(r.body) as any });

test("handler: sleep_host and wake_host go through the power port signed by the presenter; the answer comes back as the function gave it; a refusal is 409 and on the timeline; a failed invoke is 502; no function is 501", async () => {
  const host = fakeHost();
  const handler = createHandler(async () => host);
  const slept = parse(await handler(event("POST", "/presenter/sleep_host")));
  assert.equal(slept.status, 200);
  assert.equal(slept.body.action, "sleep_host");
  assert.equal(slept.body.power, "sleep", "the function's own action beside the presenter's");
  assert.equal(slept.body.state, "stopping");
  assert.equal(slept.body.marker.by, "seth@zudocs.com", "the JWT's e-mail, never a body field");
  assert.ok(host.calls.includes("power:sleep:seth@zudocs.com"));
  const row = host.store.events.find((e) => e.kind === "presenter" && e.action === "sleep_host")!;
  assert.equal(row.outcome, "stopping");
  assert.equal(row.forHost, "eu-west-1/ec2");
  const woken = parse(await handler(event("POST", "/presenter/wake_host")));
  assert.equal(woken.status, 200);
  assert.equal(woken.body.state, "pending");
  assert.ok(host.calls.includes("power:wake:seth@zudocs.com"));

  const refused = fakeHost({ refusal: "wire_cut" });
  const r = parse(await createHandler(async () => refused)(event("POST", "/presenter/sleep_host")));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "wire_cut");
  assert.equal(refused.store.events.at(-1)!.outcome, "refused: wire_cut", "the refusal is on the timeline in the function's words");

  const broken = fakeHost({ throwOnPower: true });
  const b = parse(await createHandler(async () => broken)(event("POST", "/presenter/wake_host")));
  assert.equal(b.status, 502);
  assert.equal(b.body.error, "power_failed");
  assert.match(b.body.message, /AccessDenied/);
  assert.equal(broken.store.events.length, 0, "nothing happened, nothing is on the timeline");

  const none = fakeHost({ power: false });
  const n = parse(await createHandler(async () => none)(event("POST", "/presenter/sleep_host")));
  assert.equal(n.status, 501);
  assert.equal(n.body.error, "no_power_function");
  assert.equal(none.calls.filter((c) => c.startsWith("power:")).length, 0);
});

test("handler: demo_mode writes the switch on (four hours) or off through the port, lands on the timeline, refuses any other value, and is 501 without a parameter; /state carries the reading", async () => {
  const host = fakeHost({ now: () => NOW });
  const handler = createHandler(async () => host);
  const on = parse(await handler(event("POST", "/presenter/demo_mode", { value: "on" })));
  assert.equal(on.status, 200);
  assert.equal(on.body.mode, "on");
  assert.equal(on.body.until, iso(DEMO_MODE_MAX_HOURS * 3_600_000));
  assert.match(on.body.message, /every two minutes/);
  assert.ok(host.calls.includes("demo_mode:on:seth@zudocs.com"));
  const row = host.store.events.find((e) => e.kind === "demo_mode")!;
  assert.equal(row.mode, "on");
  assert.equal(row.forHost, "eu-west-1/ec2");
  assert.equal(row.parameter, "/zudocs/dev/demo-mode");
  const state = parse(await handler(event("GET", "/state")));
  assert.equal(state.body.demoMode.mode, "on", "the state route reads the switch");
  assert.deepEqual(state.body.features, { wire: true, nudge: false, hosted: false, openai: false, anthropic: false, hostCli: true, power: true, demoMode: true });
  const off = parse(await handler(event("POST", "/presenter/demo_mode", { value: "off" })));
  assert.equal(off.body.mode, "off");
  assert.match(off.body.message, /a ticket an hour/);
  const bad = parse(await handler(event("POST", "/presenter/demo_mode", { value: "always" })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "no_such_mode");
  assert.equal(host.calls.filter((c) => c.startsWith("demo_mode:")).length, 2, "nothing was written for the refused value");

  const none = fakeHost({ demoMode: false });
  const n = parse(await createHandler(async () => none)(event("POST", "/presenter/demo_mode", { value: "on" })));
  assert.equal(n.status, 501);
  assert.equal(n.body.error, "no_demo_mode");
  assert.equal(parse(await createHandler(async () => none)(event("GET", "/state"))).body.demoMode, null);
});

test("handler: host_cli is refused while the eu-west row says the host is asleep, and runs once it is awake", async () => {
  const asleep = fakeHost({ euRow: { power: { state: "stopped", since: iso(-3_600_000), at: iso(-3_000_000), by: "the nightly schedule", instanceId: "i-eu" } } });
  const refused = parse(await createHandler(async () => asleep)(event("POST", "/presenter/host_cli", { command: "status" })));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "host_asleep");
  assert.match(refused.body.message, /asleep since 2026-09-21T15:00:00.000Z/);
  assert.equal(asleep.calls.filter((c) => c.startsWith("host_cli:")).length, 0, "no job was queued");
  const awake = fakeHost({ euRow: { power: { state: "running", since: iso(-600_000), at: iso(-500_000), by: "seth@zudocs.com", instanceId: "i-eu" } } });
  // The fake's row was written a minute ago — after the start — so the host is awake and the guard lets the command
  // through to the job (which this fake cannot hand itself: no function name, so the answer is that refusal, not host_asleep).
  (awake.env as { functionName: string }).functionName = "";
  const through = parse(await createHandler(async () => awake)(event("POST", "/presenter/host_cli", { command: "status" })));
  assert.equal(through.status, 501);
  assert.equal(through.body.error, "no_self_invoke");
});

test("handler: /state folds the eu-west row's marker into a power view and asks the function to look when a marker is in transition past its grace — and not otherwise", async () => {
  const settled = fakeHost({ euRow: { power: { state: "stopped", since: iso(-3_600_000), at: iso(-3_000_000), by: "the nightly schedule", instanceId: "i-eu" } } });
  const s = parse(await createHandler(async () => settled)(event("GET", "/state")));
  const eu = s.body.hosts.find((h: { hostId: string }) => h.hostId === "eu-west-1/ec2");
  assert.equal(eu.powerView.phase, "asleep");
  assert.equal(eu.powerView.since, iso(-3_600_000));
  assert.equal(settled.calls.filter((c) => c.startsWith("power:")).length, 0, "a settled marker asks nothing of the function");
  assert.equal(s.body.hosts.find((h: { hostId: string }) => h.hostId === "us-east-1/lambda")?.powerView, undefined, "only the eu-west host has a power view");

  // The handler reads the clock itself: a marker a minute old by that clock (past the grace, well before the give-up).
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const transition = fakeHost({ euRow: { power: { state: "pending", since: minuteAgo, at: minuteAgo, by: "seth@zudocs.com", instanceId: "i-eu" } } });
  const t = parse(await createHandler(async () => transition)(event("GET", "/state")));
  assert.ok(transition.calls.includes("power:tick:seth@zudocs.com"), "a marker in transition past the grace: the poll asks the function to look now");
  assert.equal(t.body.hosts.find((h: { hostId: string }) => h.hostId === "eu-west-1/ec2").powerView.phase, "started", "the function's fresh marker (running) is what the card gets, and the row predates it");

  const fresh = fakeHost({ euRow: { power: { state: "pending", since: new Date().toISOString(), at: new Date().toISOString(), by: "seth@zudocs.com", instanceId: "i-eu" } } });
  await createHandler(async () => fresh)(event("GET", "/state"));
  assert.equal(fresh.calls.filter((c) => c.startsWith("power:")).length, 0, "within the grace the function is left alone");
});
