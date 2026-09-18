/**
 * The Lambda entry point behind the HTTP API's Cognito JWT authorizer: every request arrives already authenticated
 * (the authorizer rejects the rest before this runs) and is routed on its raw path. Runs and presenter actions
 * happen inside `ap.invoke()` — a sync pass before, the invocation's telemetry flushed after — and every one of
 * them writes this host's status row. The daily cap is taken atomically before a run and refused as HTTP 429 with
 * the count; nothing is simulated at the line. `replay` is the one asynchronous action: the function invokes itself
 * with a job event and walks it sequentially under the same cap. The status tick (`{ tick: "status" }` from EventBridge
 * every five minutes) is a sync pass and one status row, so the card never goes stale between runs. Approvals are the eu-west host's staged releases:
 * the host writes the row, `POST /approvals/{id}/approve` records the owner's decision exactly once (a repeat
 * answers with the row as it stands), and the host activates through its daemon and settles the row.
 *
 * Errors answer as JSON with a class and a message; ticket bodies, rendered text and keys never reach a log line.
 *
 * @example
 * ```ts
 * export const handler: Handler = async (event) => ...;   // what the stack's `handler: "index.handler"` resolves
 * // curl -H "authorization: Bearer $ID_TOKEN" https://<api>/tickets
 * ```
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from "aws-lambda";
import { normalizeFeedback } from "@airprompter/agent-sdk";
import { MODELS } from "./modelCatalogue.js";
import { match } from "./router.js";
import { runTicket, type StepRecord } from "./run.js";
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
/** The scheduled status tick: not a request, not a replay. */
export const isStatusTick = (event: unknown): boolean => typeof event === "object" && event !== null && (event as { tick?: unknown }).tick === "status";

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
    if (isReplay(event) || isStatusTick(event)) return;
    return json(503, { error: "host_unavailable", name: e.name, code: e.code ?? null, message: e.message });
  }
  host.invocations += 1;
  try {
    if (isReplay(event)) {
      await replay(host, event, context);
      return;
    }
    if (isStatusTick(event)) {
      // A sync pass (on_invoke: the release is refreshed before the invocation) and the row; the heartbeat is the SDK's own cadence.
      await host.ap.invoke(async () => undefined);
      await host.writeStatus();
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
        // `capDay`, not `day`: the events table's partition key is `day` and the reader does not return it.
        await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, capDay: day, cap: env.dailyRunCap, used: slot.used, by });
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
      const normalized = normalizeFeedback(signals);
      if (!normalized.accepted) return { statusCode: 422, body: { error: "signals_refused", filed: false, signals, rejected: normalized.rejected, message: "the SDK refuses these signals: thumbs up/down, accepted, edited, or a number" } };
      // Only the signals the SDK accepts are filed, stored and shown; a refused name never reaches a log line or a chip.
      const accepted = Object.fromEntries(Object.entries(signals).filter(([name]) => !(name in normalized.rejected)));
      const outcome = await ap.invoke(async () => fileFeedback(host, run, target, accepted));
      const at = new Date().toISOString();
      await store.putFeedback({ runId: run.runId, at, signals: accepted, by, filed: outcome.filed });
      await store.appendEvent({ at, kind: "feedback", host: env.hostId, runId: run.runId, ticketId: run.ticketId, step: target.step, signals: Object.keys(accepted), filed: outcome.filed, container: outcome.container, by });
      await host.writeStatus();
      if (!outcome.filed) return { statusCode: 409, body: { filed: false, signals: accepted, error: "run_reference_foreign", message: outcome.reason } };
      return { statusCode: 200, body: { filed: true, signals: accepted, container: outcome.container, message: outcome.container === "same" ? "filed on the run's window; it leaves with the next upload" : "filed on this container against the same prompt version and arm (the run was served by another container of this host); it leaves with the next upload" } };
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
          // What the presenter panel may offer: the wire buttons exist only when the eu-west stack is deployed.
          features: { wire: env.wireFunctionArn !== "", nudge: env.nudgeQueueUrl !== "" },
        },
      };
    }
    case "events": {
      const since = event.queryStringParameters?.since ?? null;
      const events = await store.listEvents(since && /^\d{4}-\d{2}-\d{2}T/.test(since) ? since : null, 100);
      return { statusCode: 200, body: { events } };
    }
    case "list_approvals": {
      const approvals = await store.listApprovals(50);
      return { statusCode: 200, body: { approvals, pending: approvals.filter((a) => a.decision === "pending").length } };
    }
    case "approve": {
      // Everyone who can sign in is the owner (README › sign-in); the decision is recorded once, under the signer's name.
      const at = new Date().toISOString();
      const decided = await store.approve(params.approvalId!, by, at);
      if (!decided.row) return { statusCode: 404, body: { error: "no_such_approval" } };
      if (decided.ok) {
        await store.appendEvent({ at, kind: "approval_decided", host: env.hostId, approvalId: decided.row.approvalId, forHost: decided.row.hostId, generation: decided.row.generation, decision: "approved", by });
        return { statusCode: 200, body: { approval: decided.row, already: false, message: `release #${decided.row.generation} approved for ${decided.row.hostId}; the host activates it through its daemon and the card flips when it has` } };
      }
      return { statusCode: 200, body: { approval: decided.row, already: true, message: decided.row.decision === "pending" ? "that approval changed under you; read it again" : `release #${decided.row.generation} on ${decided.row.hostId} is already ${decided.row.decision}${decided.row.decidedBy ? ` (by ${decided.row.decidedBy})` : ""}` } };
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

/**
 * A run reference is minted with a key derived from the STORE's id, and every Lambda container creates its own store
 * under /tmp — so a reference minted by the container that served the run does not parse on another (an SDK gap:
 * references are not portable across a fleet's serverless containers). When the local SDK refuses the reference,
 * the desk renders the same slot for the same customer on this container (no model call — though a render that
 * itself fails files the SDK's error observation; the arm is sticky on the customer id) and files against that
 * reference, only when the version, arm and model agree with the step's record — the facts feedback lands under on
 * the window, which is also all `ap.feedback` reads from a reference. Otherwise it refuses and says why.
 */
async function fileFeedback(host: Host, run: Record<string, unknown> & { runId: string; ticketId: string }, target: { step: string; runRef: string | null }, signals: Record<string, unknown>): Promise<{ filed: boolean; container: "same" | "re-rendered" | "none"; reason: string }> {
  const { ap } = host;
  if (ap.feedback(target.runRef!, signals)) return { filed: true, container: "same", reason: "" };
  const step = (Array.isArray(run.steps) ? (run.steps as StepRecord[]) : []).find((s) => s.step === target.step);
  const values = Object.fromEntries((step?.rendered?.variables ?? []).filter((v) => v.origin === "call_site" && v.value !== null).map((v) => [v.name, v.value!]));
  if (!step?.tag || !step.rendered) return { filed: false, container: "none", reason: "the run reference was minted by another container of this host and the record carries no render to re-derive it from" };
  try {
    const rendered = await ap.prompt(step.tag, { subject: String(run.customerId) }).renderAsync(values);
    if (rendered.versionId !== step.versionId || rendered.arm !== step.arm || rendered.model !== step.model) {
      return { filed: false, container: "none", reason: `the run reference was minted by another container and this one now serves ${rendered.versionId} (arm ${rendered.arm}, ${rendered.model}) where the run was ${step.versionId} (arm ${step.arm}, ${step.model}); feedback would land on the wrong version, so it is refused` };
    }
    if (!ap.feedback(rendered.runRef, signals)) return { filed: false, container: "none", reason: "the SDK refused the re-derived run reference" };
    return { filed: true, container: "re-rendered", reason: "" };
  } catch (error) {
    return { filed: false, container: "none", reason: `the run reference was minted by another container and could not be re-derived here: ${(error as Error).message.slice(0, 200)}` };
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
    case "enqueue": {
      // "Run this ticket on that host now": the host's worker takes the queue before its timer picks a ticket.
      const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
      const hostId = typeof body.host === "string" ? body.host : "";
      if (!hostId || hostId === env.hostId) return { statusCode: 400, body: { error: "no_such_host", message: "enqueue names another host (this one runs tickets on request)" } };
      const ticket = ticketId ? await store.getTicket(ticketId) : null;
      if (!ticket) return { statusCode: 404, body: { error: "no_such_ticket" } };
      const depth = await store.enqueueTicket(hostId, ticket.ticketId);
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, ticketId: ticket.ticketId, forHost: hostId, depth });
      return { statusCode: 202, body: { action, ticketId: ticket.ticketId, host: hostId, depth, message: `${ticket.ticketId} queued for ${hostId} (${depth} waiting); its worker runs it on its next pass` } };
    }
    case "cut_wire":
    case "restore_wire": {
      // The eu-west wire function replaces the host's egress (cut) or puts it back (restore); a rule restores it
      // 15 minutes after a cut regardless, so a forgotten drill cannot strand the host.
      if (!env.wireFunctionArn) return { statusCode: 501, body: { error: "no_wire_function", message: "the eu-west stack (ZudocsSharedHost) is not deployed: nothing to cut" } };
      const region = env.wireFunctionArn.split(":")[3] ?? env.region;
      const wire = action === "cut_wire" ? "cut" : "restore";
      const out = await new LambdaClient({ region }).send(new InvokeCommand({ FunctionName: env.wireFunctionArn, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify({ action: wire, by })) }));
      const answer = out.Payload ? (JSON.parse(Buffer.from(out.Payload).toString("utf8")) as Record<string, unknown>) : {};
      if (out.FunctionError) return { statusCode: 502, body: { error: "wire_failed", action, message: String(answer.errorMessage ?? out.FunctionError).slice(0, 300) } };
      await store.appendEvent({ at: at(), kind: "wire", host: env.hostId, action: wire, by, forHost: answer.hostId ?? null, state: answer.state ?? null, restoreBy: answer.restoreBy ?? null });
      return { statusCode: 200, body: { action, ...answer, message: wire === "cut" ? `egress cut on ${String(answer.hostId ?? "the host")}: only the desk's tables stay reachable; the rule restores it by ${String(answer.restoreBy ?? "15 minutes from now")}` : `egress restored on ${String(answer.hostId ?? "the host")}` } };
    }
    case "nudge": {
      // The change-notification placeholder: one message on the fleet's queue; the puller consumes it and reads the
      // origin now (`skipPointer`). Pull-and-verify stays the only source of truth — a nudge can only say "look".
      if (!env.nudgeQueueUrl) return { statusCode: 501, body: { error: "no_nudge_queue", message: "the fleet stack (ZudocsFleet) is not deployed: nothing to nudge" } };
      const sentAt = at();
      const { messageId } = await host.nudge({ kind: "nudge", by, at: sentAt, from: env.hostId });
      await store.appendEvent({ at: sentAt, kind: "presenter", host: env.hostId, action, by, messageId });
      return { statusCode: 202, body: { action, messageId, sentAt, message: "the fleet was nudged: the puller reads the origin on its next invocation (within seconds) and the timeline shows the pull" } };
    }
    default:
      return { statusCode: 404, body: { error: "no_such_action", actions: ["heartbeat", "upload", "sync", "seed", "replay", "enqueue", "cut_wire", "restore_wire", "nudge"] } };
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
      await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, capDay: day, cap: env.dailyRunCap, used: slot.used, by: job.replay.by });
      break;
    }
    await ap.invoke(() => runTicket(host, ticket, { by: job.replay.by, kind: "run", capUsed: slot.used }));
    done += 1;
  }
  await host.writeStatus();
  await store.appendEvent({ at: new Date().toISOString(), kind: "replay_done", host: env.hostId, requested: job.replay.n, done, by: job.replay.by });
}
