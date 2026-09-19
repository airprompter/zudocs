/**
 * The Lambda entry point behind the HTTP API's Cognito JWT authorizer: every request arrives already authenticated
 * (the authorizer rejects the rest before this runs) and is routed on its raw path. Runs and presenter actions
 * happen inside `ap.invoke()` — a sync pass before, the invocation's telemetry flushed after — and every one of
 * them writes this host's status row. The daily cap is taken atomically before a run and refused as HTTP 429 with
 * the count; nothing is simulated at the line. `replay` is the one asynchronous action: the function invokes itself
 * with a job event and walks it sequentially under the same cap. The status tick (`{ tick: "status" }` from EventBridge
 * every five minutes) is a sync pass and one status row, so the card never goes stale between runs. Approvals are the eu-west host's staged releases:
 * the host writes the row, `POST /approvals/{id}/approve` records the owner's decision exactly once (a repeat
 * answers with the row as it stands), and the host activates through its daemon and settles the row. Phase 6 adds
 * the hosted staging run (`POST /tickets/{id}/hosted-run`, `hosted.ts`), the per-arm results (`GET /arms`), the
 * approval rows enriched with the ramp plan the us-east host read from the same signed manifest, and four presenter
 * actions: `host_cli` (an allowlisted `zudocs-cli` command on the eu-west host through Run Command), `policy` (this
 * host's own apply policy — an operator's act, the one way a pin loosens), `golden` (run the active release's golden
 * sets now and show the report) and `reset` (clear the desk's records and re-seed: the reset script's last step).
 * A frozen environment (a `disable` directive on the manifest) refuses every run with the SDK's own reason.
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
import { foldArms } from "./arms.js";
import { HOST_CLI_COMMANDS, isHostCliCommand } from "./hostCli.js";
import { hostedConfigured, hostedRun } from "./hosted.js";
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

/** The freeze as this host sees it: the manifest's `disable` directive on the whole agent, with the SDK's own reason line. */
export function frozenOf(host: Pick<Host, "ap">): { frozen: boolean; reason: string | null } {
  const status = host.ap.status();
  if (!status.disabled?.agent) return { frozen: false, reason: null };
  return { frozen: true, reason: status.lastRefusal ?? "the release's manifest carries a disable directive for this agent (frozen from the console)" };
}

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
      const frozen = frozenOf(host);
      if (frozen.frozen) {
        await store.appendEvent({ at: new Date().toISOString(), kind: "run_refused", host: env.hostId, ticketId: ticket.ticketId, reason: frozen.reason, by });
        return { statusCode: 423, body: { error: "frozen", message: `this host refuses to render: ${frozen.reason}. Unfreeze from the console; the next sync lifts it.`, reason: frozen.reason } };
      }
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
    case "hosted_run": {
      const ticket = await store.getTicket(params.ticketId!);
      if (!ticket) return { statusCode: 404, body: { error: "no_such_ticket" } };
      if (!host.hosted || !hostedConfigured(env)) return { statusCode: 501, body: { error: "hosted_not_configured", message: "hosted staging is not configured on this deployment: the stack names no run key parameter or run URL (RUNBOOK.md › Hosted staging)" } };
      const customer = await store.getCustomer(ticket.customerId);
      const record = await hostedRun({ ports: { env: { hosted: env.hosted, hostId: env.hostId, region: env.region, agentId: env.airprompter.agentId }, store }, client: host.hosted, ticket, customer, by });
      return { statusCode: record.ok ? 200 : 502, body: { run: record } };
    }
    case "arms": {
      const [runs, feedback] = await Promise.all([store.listRuns(), store.listAllFeedback()]);
      const folded = foldArms(runs, feedback);
      const ramps = (ap.status().ramps ?? []).map((r) => ({ experimentId: r.experimentId, tag: r.tag, arms: r.arms, weightBps: r.weightBps, step: r.step, nextStepAt: r.nextStepAt, plan: r.plan }));
      return { statusCode: 200, body: { ...folded, ramps, readAt: new Date().toISOString(), runsRead: runs.length } };
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
          features: { wire: env.wireFunctionArn !== "", nudge: env.nudgeQueueUrl !== "", hosted: hostedConfigured(env), hostCli: env.wireFunctionArn !== "" },
          hosted: hostedConfigured(env) ? { target: env.hosted.target, runUrl: env.hosted.runUrl } : null,
          frozen: frozenOf(host),
          hostCliCommands: Object.keys(HOST_CLI_COMMANDS),
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
      // The ramp plan a staged release carries: this host applied the same generation under `auto` and read it from the
      // signed manifest, so the page can show what one approval on eu-west unlocks — every step of the plan, no check-in.
      const status = ap.status();
      const rampsOf = (generation: number) => (status.generation === generation ? status.ramps ?? [] : []).map((r) => ({ experimentId: r.experimentId, tag: r.tag, arms: r.arms, weightBps: r.weightBps, plan: r.plan, readBy: env.hostId }));
      const enriched = approvals.map((a) => ({ ...a, ramps: rampsOf(a.generation) }));
      return { statusCode: 200, body: { approvals: enriched, pending: approvals.filter((a) => a.decision === "pending").length } };
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
    case "host_cli": {
      // One allowlisted `zudocs-cli` command on the eu-west host; the CLI's own document comes back and lands on the timeline.
      if (!env.wireFunctionArn) return { statusCode: 501, body: { error: "no_eu_host", message: "the eu-west stack (ZudocsSharedHost) is not deployed: no host to run the CLI on" } };
      const command = body.command;
      if (!isHostCliCommand(command)) return { statusCode: 400, body: { error: "no_such_command", message: `the desk runs exactly these on the host: ${Object.keys(HOST_CLI_COMMANDS).join(", ")}`, commands: Object.keys(HOST_CLI_COMMANDS) } };
      const result = await host.hostCli(command, command === "doctor" ? 120 : 90);
      const doc = result.document ?? {};
      const summary = summariseCli(command, doc);
      await store.appendEvent({ at: at(), kind: "host_cli", host: env.hostId, forHost: `${env.euHost.region}/ec2`, command, line: result.line, status: result.status, instanceId: result.instanceId, summary, by });
      return { statusCode: result.status === "Success" ? 200 : 502, body: { action, ...result, summary, message: result.status === "Success" ? `${result.line} on ${result.instanceId ?? "the host"}: ${summary}` : `${result.line} ${result.status.toLowerCase()} on ${result.instanceId ?? "the host"}${result.stderr ? `: ${result.stderr.slice(0, 200)}` : ""}` } };
    }
    case "policy": {
      // This host's own apply policy: an operator's act on the SDK (`setApplyPolicy`) — `auto` loosens a pin the console tightened, `unlock_required` tightens it by hand.
      const value = body.value;
      if (value !== "auto" && value !== "unlock_required") return { statusCode: 400, body: { error: "no_such_policy", message: "value is auto or unlock_required" } };
      const before = ap.status().applyPolicy;
      const after = await ap.invoke(async () => ap.setApplyPolicy(value, { by }));
      await store.appendEvent({ at: at(), kind: "policy_set", host: env.hostId, value, before: before.effective, after: after.effective, source: after.source, by });
      await host.writeStatus();
      return { statusCode: 200, body: { action, before, after, message: before.effective === after.effective ? `this host's policy was already ${after.effective} (${after.source})` : `this host's policy: ${before.effective} → ${after.effective} (${after.source}); the console's setting is advisory here` } };
    }
    case "golden": {
      // The active release's golden sets, run now against the pinned model; the SDK files goldenPass per case, the desk shows counts.
      const tag = typeof body.tag === "string" ? body.tag : undefined;
      const reports = await ap.invoke(async () => ap.golden({ ...(tag ? { tag } : {}) }));
      const summary = reports.map((r) => ({ tag: r.tag, arm: r.arm, model: r.model, cases: r.cases, passed: r.passed, failed: r.failed, passBps: r.passBps, minPassBps: r.minPassBps, meetsThreshold: r.meetsThreshold, failedCases: r.results.filter((c) => !c.ok).map((c) => ({ caseId: c.caseId, failed: c.failed, error: c.error ?? null })) }));
      await store.appendEvent({ at: at(), kind: "golden_run", host: env.hostId, generation: ap.generation, reports: summary.map((r) => ({ tag: r.tag, arm: r.arm, passed: r.passed, cases: r.cases, met: r.meetsThreshold })), by });
      await host.writeStatus();
      return { statusCode: 200, body: { action, generation: ap.generation, reports: summary, message: summary.length ? summary.map((r) => `${r.tag} (${r.arm}): ${r.passed}/${r.cases} ${r.meetsThreshold ? "meets" : "BELOW"} the ${r.minPassBps / 100}% floor`).join("; ") : "no slot of the active release carries a golden set" } };
    }
    case "reset": {
      // The reset script's clearing step: runs, feedback, approvals, events and counters gone; the inbox re-seeded.
      const counts = await store.reset([...SEED_CUSTOMERS], [...SEED_TICKETS]);
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, ...counts });
      await host.writeStatus();
      return { statusCode: 200, body: { action, ...counts, message: `cleared ${counts.runs} runs, ${counts.feedback} feedback rows, ${counts.approvals} approvals, ${counts.events} events, ${counts.counters} counters; seeded ${counts.customers} customers and ${counts.tickets} tickets` } };
    }
    default:
      return { statusCode: 404, body: { error: "no_such_action", actions: ["heartbeat", "upload", "sync", "seed", "replay", "enqueue", "cut_wire", "restore_wire", "nudge", "host_cli", "policy", "golden", "reset"] } };
  }
}

/** One line from the CLI's document, per command — what the notice and the timeline row say. */
export function summariseCli(command: string, doc: Record<string, unknown>): string {
  if (doc.ok === false) return `refused: ${String(doc.error ?? doc.reason ?? "")}`.trim();
  const policy = doc.applyPolicy as { effective?: string; source?: string; manifestSaid?: string | null; value?: string } | undefined;
  switch (command) {
    case "policy show":
      return policy ? `in force ${policy.effective ?? policy.value} (${policy.source})${policy.manifestSaid && policy.manifestSaid !== policy.effective ? `; the console says ${policy.manifestSaid} — advisory here` : ""}` : "no policy document";
    case "policy set auto":
    case "policy set unlock_required":
      return policy ? `now ${policy.effective ?? policy.value} (${policy.source}); was ${String((doc.previous as { effective?: string; value?: string } | undefined)?.effective ?? (doc.previous as { value?: string } | undefined)?.value ?? "?")}` : "set";
    case "rollback":
      return `generation ${String(doc.generation)} live (was ${String(doc.previousGeneration)})${doc.forced ? " — a forced downgrade, stamped on evidence" : ""}`;
    case "unlock":
      return `generation ${String(doc.generation)} activated (was ${String(doc.previousGeneration)})`;
    case "status":
      return `generation ${String(doc.generation)}${doc.stagedSlot ? " · a release is staged" : ""}${doc.forcedDowngrade ? " · forced downgrade" : ""} · ${String(doc.storageProtection)}`;
    case "doctor": {
      const checks = Array.isArray(doc.checks) ? (doc.checks as Array<{ name: string; level: string }>) : [];
      const warn = checks.filter((c) => c.level === "warn").map((c) => c.name);
      const fail = checks.filter((c) => c.level === "fail").map((c) => c.name);
      return `${checks.length} checks · ${fail.length} failing${fail.length ? ` (${fail.join(", ")})` : ""} · ${warn.length} warning${warn.length === 1 ? "" : "s"}${warn.length ? ` (${warn.join(", ")})` : ""}`;
    }
    default:
      return "done";
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
    const frozen = frozenOf(host);
    if (frozen.frozen) {
      await store.appendEvent({ at: new Date().toISOString(), kind: "run_refused", host: env.hostId, ticketId: ticket.ticketId, reason: frozen.reason, by: job.replay.by });
      break;
    }
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
