/**
 * The Lambda entry point behind the HTTP API's Cognito JWT authorizer: every request arrives already authenticated
 * (the authorizer rejects the rest before this runs) and is routed on its raw path. Runs and presenter actions
 * happen inside `ap.invoke()` — a sync pass before, the invocation's telemetry flushed after — and every one of
 * them writes this host's status row. The daily cap is taken atomically before a run and refused as HTTP 429 with
 * the count; nothing is simulated at the line. `replay` is the one asynchronous action: the function invokes itself
 * with a job event and walks it sequentially under the same cap.
 *
 * Errors answer as JSON with a class and a message; ticket bodies, rendered text and keys never reach a log line.
 *
 * @example
 * ```ts
 * export const handler: Handler = async (event) => ...;   // what the stack's `handler: "handler"` resolves
 * // curl -H "authorization: Bearer $ID_TOKEN" https://<api>/tickets
 * ```
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from "aws-lambda";
import { MODELS } from "./modelCatalogue.js";
import { match } from "./router.js";
import { runTicket } from "./run.js";
import { getHost, type Host } from "./runtime.js";
import { SEED_CUSTOMERS, SEED_TICKETS } from "./seedData.js";
import { dayOf } from "./store.js";

type Result = { statusCode: number; body: unknown };
const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

/** A replay job the function hands itself: N runs over the inbox, round-robin, under the cap. */
export interface ReplayJob {
  replay: { n: number; by: string; ticketIds?: string[] };
}

export const REPLAY_MAX = 30;

const isReplay = (event: unknown): event is ReplayJob => typeof event === "object" && event !== null && "replay" in event;

const whoIs = (event: APIGatewayProxyEventV2WithJWTAuthorizer): string => {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const email = claims.email ?? claims["cognito:username"] ?? claims.sub;
  return typeof email === "string" ? email : "unknown";
};

const readBody = (event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> => {
  if (!event.body) return {};
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

export type DeskHandler = (event: APIGatewayProxyEventV2WithJWTAuthorizer | ReplayJob, context?: Context) => Promise<APIGatewayProxyResultV2 | void>;

/** The handler over a host provider — the real cold-start memo in production, a fake host in tests. */
export const createHandler = (hostOf: () => Promise<Host>): DeskHandler => async (event, context) => {
  let host: Host;
  try {
    host = await hostOf();
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(JSON.stringify({ source: "desk", event: "host_start_failed", name: e.name, code: e.code ?? null, message: e.message }));
    if (isReplay(event)) return;
    return json(503, { error: "host_unavailable", name: e.name, code: e.code ?? null, message: e.message });
  }
  host.invocations += 1;
  try {
    if (isReplay(event)) {
      await replay(host, event, context);
      return;
    }
    const routed = match(event.requestContext.http.method, event.rawPath);
    if (!routed) return json(404, { error: "no_such_route" });
    const result = await dispatch(host, routed.name, routed.params, event);
    return json(result.statusCode, result.body);
  } catch (error) {
    const e = error as Error;
    console.log(JSON.stringify({ source: "desk", event: "request_failed", name: e.name, message: e.message.slice(0, 300) }));
    return json(500, { error: "request_failed", name: e.name, message: e.message.slice(0, 300) });
  } finally {
    host.coldStart = false;
  }
};

export const handler: DeskHandler = createHandler(getHost);

async function dispatch(host: Host, name: string, params: Record<string, string>, event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Result> {
  const { ap, store, env } = host;
  const by = whoIs(event);
  switch (name) {
    case "list_tickets": {
      const [tickets, customers] = await Promise.all([store.listTickets(), store.listCustomers()]);
      const byId = new Map(customers.map((c) => [c.customerId, c]));
      return { statusCode: 200, body: { tickets: tickets.map((t) => ({ ...t, customer: byId.get(t.customerId) ?? null })) } };
    }
    case "get_ticket": {
      const ticket = await store.getTicket(params.ticketId!);
      if (!ticket) return { statusCode: 404, body: { error: "no_such_ticket" } };
      const [customer, runs] = await Promise.all([store.getCustomer(ticket.customerId), store.listRunsForTicket(ticket.ticketId, 10)]);
      const withFeedback = await Promise.all(runs.map(async (run) => ({ ...run, feedback: await store.listFeedback(run.runId) })));
      return { statusCode: 200, body: { ticket: { ...ticket, customer }, runs: withFeedback } };
    }
    case "run_ticket":
    case "escalate_ticket": {
      const ticket = await store.getTicket(params.ticketId!);
      if (!ticket) return { statusCode: 404, body: { error: "no_such_ticket" } };
      const day = dayOf(new Date().toISOString());
      const slot = await store.takeRunSlot(day, env.dailyRunCap);
      if (!slot.ok) {
        await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, day, cap: env.dailyRunCap, used: slot.used, by });
        return { statusCode: 429, body: { error: "daily_cap", message: `this host refuses past ${env.dailyRunCap} runs per UTC day; ${slot.used} were used on ${day}. Nothing was simulated.`, cap: env.dailyRunCap, used: slot.used, day } };
      }
      const record = await ap.invoke(() => runTicket(host, ticket, { by, kind: name === "run_ticket" ? "run" : "escalate", capUsed: slot.used }));
      await host.writeStatus();
      return { statusCode: record.ok ? 200 : 502, body: { run: record, cap: { used: slot.used, cap: env.dailyRunCap, day } } };
    }
    case "feedback": {
      const run = await store.getRun(params.runId!);
      if (!run) return { statusCode: 404, body: { error: "no_such_run" } };
      const body = readBody(event);
      const signals = typeof body.signals === "object" && body.signals !== null ? (body.signals as Record<string, unknown>) : {};
      const step = typeof body.step === "string" ? body.step : "reply";
      const steps = Array.isArray(run.steps) ? (run.steps as Array<{ step: string; runRef: string | null }>) : [];
      const target = steps.find((s) => s.step === step) ?? steps.find((s) => s.runRef);
      if (!target?.runRef) return { statusCode: 409, body: { error: "no_run_reference", message: "that run has no run reference to file feedback against (its render never happened)" } };
      const filed = await ap.invoke(async () => ap.feedback(target.runRef!, signals));
      const at = new Date().toISOString();
      await store.putFeedback({ runId: run.runId, at, signals, by, filed });
      await store.appendEvent({ at, kind: "feedback", host: env.hostId, runId: run.runId, ticketId: run.ticketId, step: target.step, signals: Object.keys(signals), filed, by });
      await host.writeStatus();
      return { statusCode: filed ? 200 : 422, body: { filed, signals, message: filed ? "filed on the run's window; it leaves with the next upload" : "the SDK refused the signals (numbers, booleans and declared enums only)" } };
    }
    case "state": {
      const day = dayOf(new Date().toISOString());
      const [hosts, used] = await Promise.all([store.listStatus(), store.readRunSlots(day)]);
      return {
        statusCode: 200,
        body: {
          host: { hostId: env.hostId, region: env.region, sdk: host.sdk, instanceId: ap.instanceId, startedAt: host.startedAt, invocations: host.invocations, coldStart: host.coldStart, status: ap.status(), healthz: ap.healthz(), models: MODELS, stateDir: env.stateDir },
          hosts,
          cap: { day, used, cap: env.dailyRunCap },
          airprompter: { baseUrl: env.airprompter.baseUrl, environment: env.airprompter.environment, agentId: env.airprompter.agentId },
        },
      };
    }
    case "events": {
      const since = event.queryStringParameters?.since ?? null;
      const events = await store.listEvents(since && /^\d{4}-\d{2}-\d{2}T/.test(since) ? since : null, 100);
      return { statusCode: 200, body: { events } };
    }
    case "healthz": {
      const healthz = ap.healthz();
      return { statusCode: healthz.ok ? 200 : 503, body: healthz };
    }
    case "presenter":
      return presenter(host, params.action!, readBody(event), by);
    default:
      return { statusCode: 404, body: { error: "no_such_route" } };
  }
}

async function presenter(host: Host, action: string, body: Record<string, unknown>, by: string): Promise<Result> {
  const { ap, store, env } = host;
  const at = () => new Date().toISOString();
  switch (action) {
    case "heartbeat": {
      await ap.invoke(async () => ap.heartbeatNow());
      const heartbeat = ap.status().heartbeat;
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, lastAt: heartbeat.lastAt, refusal: heartbeat.lastRefusal });
      await host.writeStatus();
      return { statusCode: 200, body: { action, heartbeat } };
    }
    case "upload": {
      // On a serverless host the SDK's own flush is the upload; `uploadNow()` (the resident uploader) answers null here.
      const flushed = await ap.invoke(async () => ap.flushTelemetry());
      const uploadNow = await ap.uploadNow();
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, flush: flushed.status, uploader: uploadNow });
      await host.writeStatus();
      return { statusCode: 200, body: { action, flush: flushed, uploader: uploadNow } };
    }
    case "sync": {
      const before = ap.generation;
      await ap.invoke(async () => ap.syncNow());
      const status = ap.status();
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, before, generation: status.generation, outcome: status.lastSyncOutcome });
      await host.writeStatus();
      return { statusCode: 200, body: { action, before, generation: status.generation, stagedGeneration: status.stagedGeneration, outcome: status.lastSyncOutcome, applyState: status.applyState } };
    }
    case "seed": {
      const counts = await store.seed([...SEED_CUSTOMERS], [...SEED_TICKETS]);
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, ...counts });
      return { statusCode: 200, body: { action, ...counts } };
    }
    case "replay": {
      const n = Math.min(REPLAY_MAX, Math.max(1, Math.floor(Number(body.n ?? 5)) || 5));
      const ticketIds = Array.isArray(body.ticketIds) ? body.ticketIds.filter((t): t is string => typeof t === "string").slice(0, REPLAY_MAX) : undefined;
      if (!env.functionName) return { statusCode: 501, body: { error: "no_self_invoke", message: "replay needs the function's own name (AWS_LAMBDA_FUNCTION_NAME)" } };
      const job: ReplayJob = { replay: { n, by, ...(ticketIds ? { ticketIds } : {}) } };
      await new LambdaClient({ region: env.region }).send(new InvokeCommand({ FunctionName: env.functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(job)) }));
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, n });
      return { statusCode: 202, body: { action, n, message: `${n} run(s) queued on this host; watch the timeline` } };
    }
    default:
      return { statusCode: 404, body: { error: "no_such_action", actions: ["heartbeat", "upload", "sync", "seed", "replay"] } };
  }
}

/** The replay job: sequential runs until N, the cap, or the remaining time is short. */
async function replay(host: Host, job: ReplayJob, context?: Context): Promise<void> {
  const { ap, store, env } = host;
  const tickets = await store.listTickets();
  const chosen = job.replay.ticketIds ? tickets.filter((t) => job.replay.ticketIds!.includes(t.ticketId)) : tickets;
  if (chosen.length === 0) return;
  let done = 0;
  for (let i = 0; i < job.replay.n; i += 1) {
    if (context && context.getRemainingTimeInMillis() < 45_000) break;
    const ticket = chosen[i % chosen.length]!;
    const day = dayOf(new Date().toISOString());
    const slot = await store.takeRunSlot(day, env.dailyRunCap);
    if (!slot.ok) {
      await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, day, cap: env.dailyRunCap, used: slot.used, by: job.replay.by });
      break;
    }
    await ap.invoke(() => runTicket(host, ticket, { by: job.replay.by, kind: "run", capUsed: slot.used }));
    done += 1;
  }
  await host.writeStatus();
  await store.appendEvent({ at: new Date().toISOString(), kind: "replay_done", host: env.hostId, requested: job.replay.n, done, by: job.replay.by });
}
