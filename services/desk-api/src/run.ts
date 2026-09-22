/**
 * One ticket through the promoted prompts, inside `ap.invoke()`: triage (`support.triage` on Nova Micro, its JSON
 * read for the inbox), the reply (`support.reply` on the release's model — `customer_tier` filled by the desk's own source,
 * `tone: "formal"` passed only for an enterprise customer, the ticket fenced), the judge (`ap.judge` with the
 * prompt's own `## Success criteria`, scored on the desk's judge model), and — on `escalate` — the two-step hand-off
 * (`support.escalate.summary` then `.handoff` with the summary passed along). Every number on the record is the
 * SDK's: `Rendered` (version, arm, generation, model, inference), the observation the SDK filed (latency, tokens,
 * usage source), `ap.checks` (per-check verdicts, not recorded twice), `ap.judge`. Nothing is simulated: a model
 * that refuses leaves an error on the step and the record says so.
 *
 * The provider switch (phase 9): a run may name a direct provider — the OpenAI API or the Claude API with the customer's
 * own key (`providers.ts`) — and the reply step goes there instead of the release's model on Bedrock, the same render,
 * the same checks, the same judge; the record names the provider, the model the call named, and which of the release's
 * settings the provider took. Triage stays on the host's own path either way: the switch is about the reply the
 * prospect reads, and the desk shows the four routes side by side (AirPrompter's hosted route is `hosted.ts`).
 *
 * "Why this text": for each declared variable, where its value came from — the call site, the desk's source, the
 * declared default, or nothing — by the SDK's own precedence (call site over source over default), and whether it
 * is fenced. Values are the ones the desk passed or looked up; the render is shown as the SDK produced it.
 *
 * @example
 * ```ts
 * const record = await runTicket(host, ticket, { by: "seth@zudocs.com", kind: "run" });
 * record.steps[1].versionId;         // "rev-2"
 * record.steps[1].observation?.latencyMs;
 * ```
 */
import type { Observation, Rendered, SlotVariable } from "@airprompter/agent-sdk";
import type { RunHost } from "./runtime.js";
import { costUsd } from "./modelCatalogue.js";
import { costUsdDirect, type DirectCompletion, type DirectProvider } from "./providers.js";
import type { Completion } from "./bedrock.js";
import type { Customer, Ticket } from "./store.js";

export type StepName = "triage" | "reply" | "summary" | "handoff";

export interface VariableOrigin {
  name: string;
  trust: SlotVariable["trust"];
  origin: "call_site" | "your_source" | "default" | "unfilled";
  value: string | null;
  fenced: boolean;
  required: boolean;
}

export interface StepRecord {
  step: StepName;
  tag: string;
  versionId: string | null;
  arm: string | null;
  model: string | null;
  generation: number | null;
  runRef: string | null;
  rendered: { text: string; variables: VariableOrigin[]; inference: Rendered["inference"] | null } | null;
  output: string | null;
  observation: Observation | null;
  checks: Array<{ name: string; kind: string; verdict: "pass" | "fail"; reason?: string }>;
  costUsd: number | null;
  /** The direct provider this step went to, when one was named; null on the host's own path. */
  provider: { name: DirectProvider; model: string; applied: Record<string, number>; ignored: string[] } | null;
  judge: { score: number | null; taskPass: number; taskFail: number; taskUnclear: number; flagged: boolean; model: string } | null;
  error: { name: string; message: string } | null;
}

export interface RunRecord {
  runId: string;
  ticketId: string;
  customerId: string;
  at: string;
  by: string;
  host: string;
  kind: "run" | "escalate";
  /** Where the reply went: the host's own path (`bedrock`) or a direct provider. */
  route: "bedrock" | DirectProvider;
  generation: number;
  applyState: string;
  steps: StepRecord[];
  triage: { category: string | null; priority: string | null; summary: string | null } | null;
  reply: string | null;
  handoff: string | null;
  durationMs: number;
  capUsed: number;
  ok: boolean;
}

export const TAGS = { triage: "support.triage", reply: "support.reply", summary: "support.escalate.summary", handoff: "support.escalate.handoff" } as const;

export function newRunId(now = Date.now()): string {
  return `run_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The triage JSON, tolerant of a fenced code block; null fields when the model did not answer in shape. */
export function parseTriage(text: string): { category: string | null; priority: string | null; summary: string | null } {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { category: str(parsed.category), priority: str(parsed.priority), summary: str(parsed.summary) };
  } catch {
    return { category: null, priority: null, summary: null };
  }
}

/** Where each declared variable's value came from, by the SDK's precedence; pure over the declarations and the values. */
export function variableOrigins(declared: readonly SlotVariable[], values: Record<string, unknown>, sources: readonly string[], lookedUp: Record<string, string | undefined>): VariableOrigin[] {
  return declared.map((v) => {
    const passed = values[v.name];
    const fenced = v.trust === "end_user";
    if (passed !== undefined && passed !== null) return { name: v.name, trust: v.trust, origin: "call_site", value: String(passed), fenced, required: v.required };
    if (sources.includes(v.name)) return { name: v.name, trust: v.trust, origin: "your_source", value: lookedUp[v.name] ?? null, fenced, required: v.required };
    if (v.default !== undefined) return { name: v.name, trust: v.trust, origin: "default", value: v.default, fenced, required: v.required };
    return { name: v.name, trust: v.trust, origin: "unfilled", value: null, fenced, required: v.required };
  });
}

const emptyStep = (step: StepName, tag: string): StepRecord => ({ step, tag, versionId: null, arm: null, model: null, generation: null, runRef: null, rendered: null, output: null, observation: null, checks: [], costUsd: null, provider: null, judge: null, error: null });

const errorOf = (error: unknown): { name: string; message: string } => ({ name: (error as Error)?.name ?? "Error", message: String((error as Error)?.message ?? error).slice(0, 400) });

export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: DirectProvider) {
    super(`the ${provider} provider is not configured on this host: the deployment names no key parameter for it (RUNBOOK.md › Keys)`);
    this.name = "ProviderNotConfiguredError";
  }
}

export async function runTicket(host: RunHost, ticket: Ticket, options: { by: string; kind: "run" | "escalate"; capUsed: number; provider?: DirectProvider }): Promise<RunRecord> {
  const { ap, store, callers, env } = host;
  const direct = options.provider ? (host.direct?.[options.provider] ?? null) : null;
  if (options.provider && !direct) throw new ProviderNotConfiguredError(options.provider);
  const started = Date.now();
  const at = new Date(started).toISOString();
  const runId = newRunId(started);
  const customer = (await store.getCustomer(ticket.customerId)) ?? null;
  const subject = ticket.customerId;
  const steps: StepRecord[] = [];
  let triage: RunRecord["triage"] = null;
  let reply: string | null = null;
  let handoff: string | null = null;

  /** Render one slot, call its model, run its checks, capture the SDK's observation. */
  const runStep = async (step: StepName, tag: string, values: Record<string, string>, judge: boolean, viaDirect = false): Promise<StepRecord> => {
    const record = emptyStep(step, tag);
    try {
      const handle = ap.prompt(tag, { subject });
      const declared = handle.variables();
      const rendered = await handle.renderAsync(values);
      record.versionId = rendered.versionId;
      record.arm = rendered.arm;
      record.model = rendered.model;
      record.generation = rendered.generation;
      record.runRef = rendered.runRef;
      record.rendered = { text: rendered.text, variables: variableOrigins(declared, values, ap.status().variables.sources, { customer_tier: customer?.tier }), inference: rendered.inference ?? null };
      const outcome = await host.observed((): Promise<Completion | DirectCompletion> => (viaDirect && direct ? direct.complete(rendered) : callers.complete(rendered)));
      record.observation = outcome.observations.find((o) => o.tag === tag) ?? outcome.observations[0] ?? null;
      if (outcome.result === undefined) throw outcome.error;
      const result = outcome.result;
      record.output = result.text;
      if ("provider" in result) {
        // The observation is filed under the model the call named; the checks are the render's; the price is the provider's list.
        record.provider = { name: result.provider, model: result.model, applied: result.applied, ignored: result.ignored };
        record.model = result.model;
      }
      const outputTokens = record.observation?.tokens?.output ?? null;
      // The wrapper already counted the checks on the window; this is the per-check view, not recorded again.
      record.checks = ap.checks(rendered, result.text, { outputTokens, record: false }).results;
      record.costUsd = record.provider ? costUsdDirect(record.provider.name, record.provider.model, record.observation?.tokens, record.observation?.usageSource) : costUsd(rendered.model, record.observation?.tokens, record.observation?.usageSource);
      if (judge && result.text) {
        try {
          const verdict = await ap.judge(rendered.runRef, result.text, "prompt", (prompt) => callers.judge(prompt));
          record.judge = { score: verdict.score, taskPass: verdict.taskPass, taskFail: verdict.taskFail, taskUnclear: verdict.taskUnclear, flagged: verdict.flagged, model: callers.judgeModel };
        } catch (error) {
          record.error = { name: "JudgeFailed", message: errorOf(error).message };
        }
      }
    } catch (error) {
      record.error = errorOf(error);
    }
    steps.push(record);
    return record;
  };

  const ticketValues = { ticket: ticket.body };
  if (options.kind === "run") {
    const t = await runStep("triage", TAGS.triage, ticketValues, false);
    if (t.output) triage = parseTriage(t.output);
    const replyValues: Record<string, string> = customer?.tier === "enterprise" ? { ...ticketValues, tone: "formal" } : ticketValues;
    const r = await runStep("reply", TAGS.reply, replyValues, true, direct !== null);
    reply = r.output;
  } else {
    const s = await runStep("summary", TAGS.summary, ticketValues, false);
    if (s.output) {
      const h = await runStep("handoff", TAGS.handoff, { summary: s.output }, false);
      handoff = h.output;
    }
  }
  const status = ap.status();
  const record: RunRecord = {
    runId,
    ticketId: ticket.ticketId,
    customerId: ticket.customerId,
    at,
    by: options.by,
    host: env.hostId,
    kind: options.kind,
    route: direct?.provider ?? "bedrock",
    generation: status.generation,
    applyState: status.applyState,
    steps,
    triage,
    reply,
    handoff,
    durationMs: Date.now() - started,
    capUsed: options.capUsed,
    ok: steps.length > 0 && steps.every((s) => s.error === null && s.output !== null),
  };
  await store.putRun(record as unknown as Record<string, unknown> & { runId: string; ticketId: string; at: string });
  if (options.kind === "run") {
    const replyStep = steps.find((s) => s.step === "reply");
    await store.updateTicketLastRun(ticket.ticketId, { runId, at, category: triage?.category ?? null, priority: triage?.priority ?? null, ...(replyStep?.versionId ? { versionId: replyStep.versionId } : {}), ...(replyStep?.arm ? { arm: replyStep.arm } : {}) });
  }
  const eventStep = steps.find((s) => s.step === "reply") ?? steps[steps.length - 1];
  await store.appendEvent({ at: new Date().toISOString(), kind: options.kind === "run" ? "ticket_run" : "ticket_escalated", host: env.hostId, ticketId: ticket.ticketId, runId, generation: status.generation, versionId: eventStep?.versionId ?? null, arm: eventStep?.arm ?? null, model: eventStep?.model ?? null, ok: record.ok, latencyMs: eventStep?.observation?.latencyMs ?? null, route: record.route, by: options.by });
  return record;
}

export type { Customer };
