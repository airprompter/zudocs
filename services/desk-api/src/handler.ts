/**
 * The Lambda entry point behind the HTTP API's Cognito JWT authorizer: every request arrives already authenticated
 * (the authorizer rejects the rest before this runs) and is routed on its raw path. Runs and presenter actions
 * happen inside `ap.invoke()` — a sync pass before, the invocation's telemetry flushed after — and every one of
 * them writes this host's status row. The daily cap is taken atomically before a run and refused as HTTP 429 with
 * the count; nothing is simulated at the line. `replay` is the one asynchronous action: the function invokes itself
 * with a job event and walks it sequentially under the same cap. The status tick (`{ tick: "status" }` from EventBridge
 * every five minutes) is a sync pass and one status row, so the card never goes stale between runs. Approvals are the eu-west host's staged releases:
 * the host writes the row, `POST /approvals/{id}/approve` records the owner's decision exactly once (a repeat
 * answers with the row as it stands; a row the host has moved past — a newer generation staged on the same store,
 * or the host's own row saying something else is staged — answers `409 approval_stale` and is not approved), and
 * the host activates through its daemon and settles the row. Phase 6 adds
 * the hosted staging run (`POST /tickets/{id}/hosted-run`, `hosted.ts`), the per-arm results (`GET /arms`), the
 * approval rows enriched with the ramp plan the us-east host read from the same signed manifest, and four presenter
 * actions: `host_cli` (an allowlisted `zudocs-cli` command on the eu-west host through Run Command), `policy` (this
 * host's own apply policy — an operator's act, the one way a pin loosens), `golden` (run the active release's golden
 * sets now and show the report) and `reset` (clear the desk's records and re-seed: the reset script's last step).
 * A frozen environment (a `disable` directive on the manifest) refuses every run with the SDK's own reason.
 * Phase 8 adds three more: `sleep_host` and `wake_host` (the eu-west host stopped and started through the power
 * function; the card reads asleep since / waking from the row's marker, and a poll that finds the marker in
 * transition asks the function to look now) and `demo_mode` (the eu-west workers' cadence switch, on for at most
 * four hours or off). `host_cli` is refused while the host is asleep instead of timing out on Run Command.
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
import { HOST_CLI_COMMANDS, documentOf, isHostCliCommand, type HostCliCommand } from "./hostCli.js";
import { needsReconcile, powerView, type PowerMarker } from "./hostPower.js";
import { redactKeyShaped } from "./redact.js";
import { hostedConfigured, hostedRun } from "./hosted.js";
import { DIRECT_PROVIDERS, PROVIDER_LABEL, providerConfigured, type DirectProvider } from "./providers.js";
import { parseProviderSwitch, type SwitchState } from "./providerGuard.js";
import { MODELS } from "./modelCatalogue.js";
import { match } from "./router.js";
import { runTicket, type StepRecord } from "./run.js";
import { getHost, type Host } from "./runtime.js";
import { SEED_CUSTOMERS, SEED_TICKETS } from "./seedData.js";
import { dayOf, type ApprovalRow, type StatusRow } from "./store.js";

type Result = { statusCode: number; body: unknown };
const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

/** A replay job the function hands itself: N runs over the inbox, round-robin, under the cap. */
export interface ReplayJob {
  replay: { n: number; by: string; ticketIds?: string[] };
}
/** A host-CLI job the function hands itself: one allowlisted command on the eu-west host; the result lands on the timeline. */
export interface HostCliJob {
  hostCli: { command: HostCliCommand; by: string; requestedAt: string };
}

export const REPLAY_MAX = 30;

const isReplay = (event: unknown): event is ReplayJob => typeof event === "object" && event !== null && "replay" in event;
const isHostCliJob = (event: unknown): event is HostCliJob => typeof event === "object" && event !== null && "hostCli" in event;
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

/**
 * Is this approval row still the one its host would activate? Two readings, both from the desk's own tables: another
 * row of the same host and store for a newer generation (the watcher opened it when the daemon staged past this one —
 * the watcher settles the old row on the same tick, but the click can race it), and the host's status row, when it
 * was written after this row was staged, naming a different staged generation (or none: the release went live or
 * away on the host). A stale row is refused so a late click never approves a generation the host no longer holds
 * staged. Pure.
 */
export function approvalStaleness(row: ApprovalRow, approvals: ApprovalRow[], hosts: StatusRow[]): { stale: boolean; reason: string | null } {
  const newer = approvals.filter((a) => a.hostId === row.hostId && a.storeId === row.storeId && a.generation > row.generation).sort((a, b) => b.generation - a.generation)[0];
  if (newer) return { stale: true, reason: `release #${row.generation} is no longer what ${row.hostId} holds staged: #${newer.generation} was staged in its place (its own row is ${newer.decision})` };
  const host = hosts.find((h) => h.hostId === row.hostId);
  const status = host?.status as { stagedGeneration?: number | null; generation?: number } | undefined;
  if (host && status && typeof status.generation === "number" && Date.parse(host.writtenAt) > Date.parse(row.stagedAt) && status.stagedGeneration !== row.generation) {
    if (status.generation >= row.generation) return { stale: true, reason: `release #${row.generation} is not staged on ${row.hostId} any more: its row written at ${host.writtenAt} says #${status.generation} is live${status.stagedGeneration ? ` and #${status.stagedGeneration} is staged` : " and nothing is staged"}` };
    if (status.stagedGeneration) return { stale: true, reason: `release #${row.generation} is not staged on ${row.hostId} any more: its row written at ${host.writtenAt} says #${status.stagedGeneration} is staged (#${status.generation} live)` };
  }
  return { stale: false, reason: null };
}

/** The freeze as this host sees it: the manifest's `disable` directive on the whole agent (`status().disabled.agent`). */
export const FROZEN_REASON = "the release's manifest carries a disable directive for this agent — frozen from the console";
export function frozenOf(host: Pick<Host, "ap">): { frozen: boolean; reason: string | null } {
  const status = host.ap.status();
  if (!status.disabled?.agent) return { frozen: false, reason: null };
  return { frozen: true, reason: FROZEN_REASON };
}

/** Thrown inside the invoke, after its sync pass, so a run is refused by the release this container just verified — before a cap slot is taken. */
class FrozenError extends Error {
  constructor() {
    super(FROZEN_REASON);
    this.name = "FrozenError";
  }
}

export type DeskHandler = (event: APIGatewayProxyEventV2WithJWTAuthorizer | ReplayJob | HostCliJob, context?: Context) => Promise<APIGatewayProxyResultV2 | void>;

/** The handler over a host provider — the real cold-start memo in production, a fake host in tests. */
export const createHandler = (hostOf: () => Promise<Host>): DeskHandler => async (event, context) => {
  let host: Host;
  try {
    host = await hostOf();
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(JSON.stringify({ source: "desk", event: "host_start_failed", name: e.name, code: e.code ?? null, message: e.message }));
    if (isReplay(event) || isHostCliJob(event) || isStatusTick(event)) return;
    return json(503, { error: "host_unavailable", name: e.name, code: e.code ?? null, message: e.message });
  }
  host.invocations += 1;
  try {
    if (isReplay(event)) {
      await replay(host, event, context);
      return;
    }
    if (isHostCliJob(event)) {
      await hostCliJob(host, event);
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
      // The provider switch (phase 9): `{ provider: "openai" | "anthropic" }` sends the reply to that API with the customer's
      // own key; absent (or "bedrock"), the release's model on this host. AirPrompter's hosted route is its own route.
      const asked = readBody(event).provider;
      const provider: DirectProvider | null = asked === undefined || asked === "bedrock" ? null : (DIRECT_PROVIDERS as readonly unknown[]).includes(asked) ? (asked as DirectProvider) : undefined as never;
      if (provider === undefined) return { statusCode: 400, body: { error: "unknown_provider", message: `provider must be one of bedrock, ${DIRECT_PROVIDERS.join(", ")} (AirPrompter's hosted route is POST /tickets/{id}/hosted-run)` } };
      if (provider && (name !== "run_ticket" || !providerConfigured(env.providers, provider) || !host.direct?.[provider])) {
        return name !== "run_ticket"
          ? { statusCode: 400, body: { error: "provider_on_escalate", message: "the provider switch applies to a run, not an escalation" } }
          : { statusCode: 501, body: { error: "provider_not_configured", provider, message: `the ${PROVIDER_LABEL[provider]} is not configured on this deployment: the stack names no key parameter for it (RUNBOOK.md › Keys)` } };
      }
      // The two guards the budget's deny policy cannot apply to a door that is plain HTTPS egress (providerGuard.ts):
      // the owner's kill switch first (cheap, and it takes no slot), then this provider's own daily line.
      if (provider) {
        const doors = host.providerSwitch ? await host.providerSwitch.read() : { ...parseProviderSwitch(null), parameter: "" };
        const door = doors[provider];
        if (!door.open) {
          await store.appendEvent({ at: new Date().toISOString(), kind: "provider_refused", host: env.hostId, ticketId: ticket.ticketId, provider, reason: door.reason, by });
          return { statusCode: 503, body: { error: "provider_disabled", provider, reason: door.reason, message: `the ${PROVIDER_LABEL[provider]} door is closed on this host (${door.reason}): the owner opens it from the presenter panel, or the parameter ${doors.parameter || "is not configured"}. Nothing was called.` } };
        }
      }
      const day = dayOf(new Date().toISOString());
      // Inside the invoke, after its sync pass: the freeze this container just verified refuses before a cap slot is
      // taken; then the slot, atomically; then the run. A refusal answers as itself, not as a run.
      const outcome = await ap.invoke(async (): Promise<{ kind: "run"; record: Awaited<ReturnType<typeof runTicket>>; used: number } | { kind: "cap"; used: number } | { kind: "provider_cap"; provider: DirectProvider; used: number }> => {
        if (frozenOf(host).frozen) throw new FrozenError();
        if (provider) {
          const door = await store.takeProviderSlot(day, provider, env.providerDailyCap);
          if (!door.ok) return { kind: "provider_cap", provider, used: door.used };
        }
        const slot = await store.takeRunSlot(day, env.dailyRunCap);
        if (!slot.ok) return { kind: "cap", used: slot.used };
        return { kind: "run", record: await runTicket(host, ticket, { by, kind: name === "run_ticket" ? "run" : "escalate", capUsed: slot.used, ...(provider ? { provider } : {}) }), used: slot.used };
      }).catch(async (error: unknown) => {
        if (!(error instanceof FrozenError)) throw error;
        await store.appendEvent({ at: new Date().toISOString(), kind: "run_refused", host: env.hostId, ticketId: ticket.ticketId, reason: FROZEN_REASON, by });
        return { kind: "frozen" as const, used: 0 };
      });
      if (outcome.kind === "frozen") return { statusCode: 423, body: { error: "frozen", message: `this host refuses to render: ${FROZEN_REASON}. Unfreeze from the console; the next sync lifts it.`, reason: FROZEN_REASON } };
      if (outcome.kind === "provider_cap") {
        await store.appendEvent({ at: new Date().toISOString(), kind: "provider_cap_refused", host: env.hostId, ticketId: ticket.ticketId, provider: outcome.provider, capDay: day, cap: env.providerDailyCap, used: outcome.used, by });
        return { statusCode: 429, body: { error: "provider_cap", provider: outcome.provider, message: `this host refuses past ${env.providerDailyCap} ${PROVIDER_LABEL[outcome.provider]} calls per UTC day; ${outcome.used} were used on ${day}. The release's own model is unaffected. Nothing was simulated.`, cap: env.providerDailyCap, used: outcome.used, day } };
      }
      if (outcome.kind === "cap") {
        // `capDay`, not `day`: the events table's partition key is `day` and the reader does not return it.
        await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, capDay: day, cap: env.dailyRunCap, used: outcome.used, by });
        return { statusCode: 429, body: { error: "daily_cap", message: `this host refuses past ${env.dailyRunCap} runs per UTC day; ${outcome.used} were used on ${day}. Nothing was simulated.`, cap: env.dailyRunCap, used: outcome.used, day } };
      }
      await host.writeStatus();
      return { statusCode: outcome.record.ok ? 200 : 502, body: { run: outcome.record, cap: { used: outcome.used, cap: env.dailyRunCap, day } } };
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
      // A sync pass first (on_invoke: one pointer read when nothing changed): several containers stay warm behind the
      // API, and the one answering this poll must know the freeze, the generation and the ramp the others do.
      await ap.invoke(async () => undefined);
      const day = dayOf(new Date().toISOString());
      const [hosts, used, demoMode, doors, providerUsed] = await Promise.all([
        store.listStatus(),
        store.readRunSlots(day),
        host.demoMode ? host.demoMode.read().catch((error: Error) => ({ mode: "off" as const, until: null, by: null, reason: `unreadable: ${error.name}`, parameter: env.demoModeParameter })) : Promise.resolve(null),
        // A door the switch cannot be read for is closed, and says so: the same fail-closed rule the run route applies.
        host.providerSwitch ? host.providerSwitch.read().catch((error: Error) => ({ ...parseProviderSwitch(null), parameter: `unreadable: ${error.name}` })) : Promise.resolve({ ...parseProviderSwitch(null), parameter: "" }),
        store.readProviderSlots(day),
      ]);
      // The eu-west host's power (phase 8): the marker folded into what the card says; a marker still in transition
      // past its grace makes this poll ask the power function to look now, so the card settles without the tick.
      const euHostId = `${env.euHost.region}/ec2`;
      const euRow = hosts.find((h) => h.hostId === euHostId) as (StatusRow & { power?: PowerMarker }) | undefined;
      if (euRow && env.powerFunctionArn && needsReconcile(euRow.power ?? null, Date.now())) {
        const looked = await host.power("tick", by).catch(() => null);
        if (looked?.marker) euRow.power = looked.marker;
      }
      const withPower = hosts.map((h) => (h.hostId === euHostId ? { ...h, powerView: powerView((h as { power?: PowerMarker }).power ?? null, h.writtenAt, Date.now()) } : h));
      return {
        statusCode: 200,
        body: {
          host: { hostId: env.hostId, region: env.region, sdk: host.sdk, instanceId: ap.instanceId, startedAt: host.startedAt, invocations: host.invocations, coldStart: host.coldStart, status: ap.status(), healthz: ap.healthz(), models: MODELS, stateDir: env.stateDir },
          hosts: withPower,
          cap: { day, used, cap: env.dailyRunCap },
          airprompter: { baseUrl: env.airprompter.baseUrl, environment: env.airprompter.environment, agentId: env.airprompter.agentId },
          // What the presenter panel may offer: the wire buttons exist only when the eu-west stack is deployed.
          features: { wire: env.wireFunctionArn !== "", nudge: env.nudgeQueueUrl !== "", hosted: hostedConfigured(env), openai: providerConfigured(env.providers, "openai"), anthropic: providerConfigured(env.providers, "anthropic"), hostCli: env.wireFunctionArn !== "", power: env.powerFunctionArn !== "", demoMode: host.demoMode !== null },
          demoMode,
          hosted: hostedConfigured(env) ? { target: env.hosted.target, runUrl: env.hosted.runUrl } : null,
          // The provider switch: which direct APIs this deployment can send a reply to, the model each names (never a
          // key), whether the owner's door is open, and what each has spent of its own daily line.
          providers: Object.fromEntries(DIRECT_PROVIDERS.map((p) => [p, { configured: providerConfigured(env.providers, p), model: env.providers[p].model, label: PROVIDER_LABEL[p], door: doors[p], used: providerUsed[p] ?? 0, cap: env.providerDailyCap }])),
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
      await ap.invoke(async () => undefined);
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
      const current = await store.getApproval(params.approvalId!);
      if (!current) return { statusCode: 404, body: { error: "no_such_approval" } };
      if (current.decision === "pending") {
        const [approvals, hosts] = await Promise.all([store.listApprovals(50), store.listStatus()]);
        const staleness = approvalStaleness(current, approvals, hosts);
        if (staleness.stale) return { statusCode: 409, body: { error: "approval_stale", approval: current, message: `not approved: ${staleness.reason}; the host settles this row on its next tick` } };
      }
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
      // One allowlisted `zudocs-cli` command on the eu-west host, as a job this function hands itself (the HTTP API caps
      // an integration at 30 s; Run Command's dispatch plus `doctor` can take a minute): the CLI's own document lands on
      // the timeline as a `host_cli` row, which the presenter panel shows.
      if (!env.wireFunctionArn) return { statusCode: 501, body: { error: "no_eu_host", message: "the eu-west stack (ZudocsSharedHost) is not deployed: no host to run the CLI on" } };
      const command = body.command;
      if (!isHostCliCommand(command)) return { statusCode: 400, body: { error: "no_such_command", message: `the desk runs exactly these on the host: ${Object.keys(HOST_CLI_COMMANDS).join(", ")}`, commands: Object.keys(HOST_CLI_COMMANDS) } };
      if (!env.functionName) return { statusCode: 501, body: { error: "no_self_invoke", message: "the host CLI needs the function's own name (AWS_LAMBDA_FUNCTION_NAME)" } };
      const asleep = await euHostPower(host);
      if (asleep.phase !== "awake") return { statusCode: 409, body: { error: "host_asleep", command, power: asleep, message: `the eu-west host is ${asleep.label}${asleep.since ? ` since ${asleep.since}` : ""}: nothing to run the CLI on — wake the fleet first` } };
      const requestedAt = at();
      const job: HostCliJob = { hostCli: { command, by, requestedAt } };
      await new LambdaClient({ region: env.region }).send(new InvokeCommand({ FunctionName: env.functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(job)) }));
      await store.appendEvent({ at: requestedAt, kind: "presenter", host: env.hostId, action, by, command, forHost: `${env.euHost.region}/ec2` });
      return { statusCode: 202, body: { action, command, line: HOST_CLI_COMMANDS[command], requestedAt, message: `zudocs-cli ${command} queued for the eu-west host; the timeline shows the CLI's answer when it lands (seconds; doctor takes up to a minute)` } };
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
    case "sleep_host":
    case "wake_host": {
      // The eu-west power function: StopInstances / StartInstances on the tagged instance, its own answer back (a
      // refusal names why: the wire is cut, a replacement is in progress, the instance is between states).
      if (!env.powerFunctionArn) return { statusCode: 501, body: { error: "no_power_function", message: "the eu-west stack (ZudocsSharedHost) is not deployed: no host to sleep or wake" } };
      const power = action === "sleep_host" ? "sleep" : "wake";
      let answer;
      try {
        answer = await host.power(power, by);
      } catch (error) {
        return { statusCode: 502, body: { error: "power_failed", action, message: (error as Error).message.slice(0, 300) } };
      }
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, forHost: answer.hostId ?? null, state: answer.state ?? null, outcome: answer.refusal ? `refused: ${answer.refusal}` : answer.changed ? answer.state : "already" });
      const { action: powerAction, ...rest } = answer;
      if (answer.refusal) return { statusCode: 409, body: { action, power: powerAction, ...rest, error: answer.refusal } };
      return { statusCode: 200, body: { action, power: powerAction, ...rest } };
    }
    case "provider_door": {
      // The kill switch: `{ provider, state }` — the owner closes a door in a hurry, or opens it again, with no deploy.
      if (!host.providerSwitch) return { statusCode: 501, body: { error: "switch_not_configured", message: "this deployment names no provider switch parameter (PROVIDERS_PARAMETER); every direct door reads closed" } };
      const asked = body.provider;
      if (!(DIRECT_PROVIDERS as readonly unknown[]).includes(asked)) return { statusCode: 400, body: { error: "unknown_provider", message: `provider must be one of ${DIRECT_PROVIDERS.join(", ")}` } };
      const state = body.state;
      if (state !== "on" && state !== "off") return { statusCode: 400, body: { error: "unknown_state", message: "state must be on or off" } };
      const doors = await host.providerSwitch.write(asked as DirectProvider, state as SwitchState, by);
      await store.appendEvent({ at: at(), kind: "presenter", host: env.hostId, action, by, provider: asked, state });
      return { statusCode: 200, body: { action, provider: asked, state, doors: Object.fromEntries(DIRECT_PROVIDERS.map((p) => [p, doors[p]])), parameter: doors.parameter } };
    }
    case "demo_mode": {
      // The eu-west workers' cadence switch: on (until four hours from now) or off; the workers read it within a minute.
      if (!host.demoMode) return { statusCode: 501, body: { error: "no_demo_mode", message: "this deployment names no demo-mode parameter (DEMO_MODE_PARAMETER)" } };
      const value = body.value;
      if (value !== "on" && value !== "off") return { statusCode: 400, body: { error: "no_such_mode", message: "value is on or off" } };
      const written = await host.demoMode.write(value, by);
      await store.appendEvent({ at: at(), kind: "demo_mode", host: env.hostId, mode: written.mode, until: written.until, by, parameter: written.parameter, forHost: `${env.euHost.region}/ec2` });
      return { statusCode: 200, body: { action, ...written, message: written.mode === "on" ? `demo mode on until ${written.until}: the eu-west workers run a ticket every two minutes (Python: five) within a minute, and the nightly sleep skips the host while it is on` : "demo mode off: the eu-west workers return to a ticket an hour (Python: every two) at their next read" } };
    }
    default:
      return { statusCode: 404, body: { error: "no_such_action", actions: ["heartbeat", "upload", "sync", "seed", "replay", "enqueue", "cut_wire", "restore_wire", "nudge", "host_cli", "policy", "golden", "reset", "sleep_host", "wake_host", "demo_mode"] } };
  }
}

/** The eu-west host's power as its status row says it (phase 8): awake when there is no marker or no row at all. */
async function euHostPower(host: Host): Promise<ReturnType<typeof powerView>> {
  const euHostId = `${host.env.euHost.region}/ec2`;
  const row = (await host.store.listStatus()).find((h) => h.hostId === euHostId) as (StatusRow & { power?: PowerMarker }) | undefined;
  return powerView(row?.power ?? null, row?.writtenAt ?? null, Date.now());
}

/**
 * The host-CLI job: run the command through Run Command, put the CLI's document on the timeline — after the strips'
 * key-shaped scan (`redact.ts`) over stdout and stderr: the CLI prints no key, so a hit is a bug on the host, and the
 * row then carries `[redacted]` and says how many spans were replaced instead of carrying the thing itself.
 */
async function hostCliJob(host: Host, job: HostCliJob): Promise<void> {
  const { store, env } = host;
  const { command, by, requestedAt } = job.hostCli;
  let result: Awaited<ReturnType<Host["hostCli"]>>;
  try {
    result = await host.hostCli(command, command === "doctor" ? 120 : 90);
  } catch (error) {
    const message = redactKeyShaped((error as Error).message ?? String(error)).text.slice(0, 200);
    await store.appendEvent({ at: new Date().toISOString(), kind: "host_cli", host: env.hostId, forHost: `${env.euHost.region}/ec2`, command, line: HOST_CLI_COMMANDS[command], status: "Failed", instanceId: null, summary: `Run Command could not be sent: ${message}`, document: null, stdout: "", requestedAt, by });
    return;
  }
  const stdout = redactKeyShaped(result.stdout);
  const stderr = redactKeyShaped(result.stderr);
  const redacted = stdout.hits + stderr.hits;
  // The document is re-read from the redacted text when anything was hit: what the row carries is what the row shows.
  const document = redacted ? documentOf(stdout.text) : result.document;
  const summary = redacted ? `${summariseCli(command, document ?? {})} — ${redacted} key-shaped span(s) in the host's output were redacted before this row was written (the CLI prints none: a bug on the host)` : summariseCli(command, document ?? {});
  if (redacted) console.log(JSON.stringify({ source: "desk", event: "host_cli_redacted", command, hits: redacted }));
  await store.appendEvent({ at: new Date().toISOString(), kind: "host_cli", host: env.hostId, forHost: `${env.euHost.region}/ec2`, command, line: result.line, status: result.status, instanceId: result.instanceId, summary, document, stdout: stdout.text.slice(0, 4000), stderr: stderr.text.slice(0, 1000), redacted, durationMs: result.durationMs, requestedAt, by });
}

/** One line from the CLI's document, per command — what the notice and the timeline row say. */
export function summariseCli(command: string, doc: Record<string, unknown>): string {
  if (doc.ok === false) return `refused: ${String(doc.error ?? doc.reason ?? "")}`.trim();
  const policy = doc.applyPolicy as { effective?: string; source?: string; manifestSaid?: string | null; value?: string } | undefined;
  switch (command) {
    case "policy show":
      return policy ? `in force ${policy.effective ?? policy.value} (${policy.source})${policy.manifestSaid && policy.manifestSaid !== policy.effective ? `; the console says ${policy.manifestSaid} — advisory here` : ""}` : "no policy document";
    case "rollback":
      return `generation ${String(doc.generation ?? "?")} live${doc.previousGeneration !== undefined ? ` (was ${String(doc.previousGeneration)})` : ""}${doc.forced ? " — a forced downgrade, stamped on evidence" : ""}`;
    case "unlock":
      return doc.generation === null || doc.generation === undefined ? "nothing was staged; nothing activated" : `generation ${String(doc.generation)} activated${doc.previousGeneration !== undefined ? ` (was ${String(doc.previousGeneration)})` : ""}`;
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
    const day = dayOf(new Date().toISOString());
    // The same order as a click: inside the invoke (after its sync pass) the freeze, then the cap slot, then the run.
    const outcome = await ap.invoke(async (): Promise<"run" | "frozen" | { cap: number }> => {
      if (frozenOf(host).frozen) return "frozen";
      const slot = await store.takeRunSlot(day, env.dailyRunCap);
      if (!slot.ok) return { cap: slot.used };
      await runTicket(host, ticket, { by: job.replay.by, kind: "run", capUsed: slot.used });
      return "run";
    });
    if (outcome === "frozen") {
      await store.appendEvent({ at: new Date().toISOString(), kind: "run_refused", host: env.hostId, ticketId: ticket.ticketId, reason: FROZEN_REASON, by: job.replay.by });
      break;
    }
    if (outcome !== "run") {
      await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, capDay: day, cap: env.dailyRunCap, used: outcome.cap, by: job.replay.by });
      break;
    }
    done += 1;
  }
  await host.writeStatus();
  await store.appendEvent({ at: new Date().toISOString(), kind: "replay_done", host: env.hostId, requested: job.replay.n, done, by: job.replay.by });
}
