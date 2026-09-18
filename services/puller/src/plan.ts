/**
 * The puller's decisions, pure over what it knows: what woke it (the schedule, or a nudge from the queue), what the
 * table holds (the newest generation and which key it is sealed to), what the exchange holds (the air-gapped host's
 * public key, when one has been published) and its own state row (the edge pointer's ETags, the backoff, the read
 * counters). `planPull` says whether to call `pullBundle` this time and how — pointer-first on a tick, `skipPointer`
 * on a nudge, and a re-pull to seal the held generation to a key the host published since — and `advance` folds a
 * result back into the state: the SDK's `nextPullDelayMs` stretches the interval while nothing changes and snaps it
 * back on any change, refusal or outage; the edge state is taken only from a result that hands one back.
 *
 * @example
 * ```ts
 * const plan = planPull({ now, trigger: { kind: "tick" }, state, newest, keyId });      // { pull: true, reason: "tick", skipPointer: false, edge }
 * const result = await pullBundle({ …, edge: plan.edge, skipPointer: plan.skipPointer, distributionPublicKey });
 * const next = advance(state, result, { now, intervalMs: 300_000 });                     // streak, nextPullAt, reads
 * ```
 */
import type { PullBundleResult, PullEdgeState } from "@airprompter/agent-sdk";
import { nextPullDelayMs } from "@airprompter/agent-sdk";

export interface ReleaseRow {
  pk: string;
  generation: number;
  releaseDigest: string;
  pulledAt: string;
  /** The distribution key the bundle is sealed to (`keyId` from the host's public key file); null for a plaintext dev bundle. */
  keyId: string | null;
  /** The bundle object in the exchange bucket. */
  object: string;
  bytes: number;
  notAfter: string;
  /** How the pull that wrote this row was triggered. */
  via: "tick" | "nudge" | "reseal";
}

/** What the puller remembers between ticks, on its own row in the releases table (generation 0). */
export interface PullerState {
  edge: PullEdgeState | null;
  unchangedStreak: number;
  nextPullAt: string | null;
  /** Reads this hour: pointer (a CDN read) and origin (an API read), for the card's cost line. */
  reads: { hour: string; pointer: number; origin: number };
  lastPull: { at: string; outcome: string; via: string | null; reason: string | null; detail: string | null; generation: number | null; trigger: string } | null;
  nudges: number;
  /** What the puller mirrored last from the air-gapped host's status document. */
  airgap: { writtenAt: string | null; startedAt: string | null; lastAppliedAt: string | null; lastExportAt: string | null; health: string | null; keyId: string | null };
}

export const EMPTY_STATE: PullerState = Object.freeze({ edge: null, unchangedStreak: 0, nextPullAt: null, reads: { hour: "", pointer: 0, origin: 0 }, lastPull: null, nudges: 0, airgap: { writtenAt: null, startedAt: null, lastAppliedAt: null, lastExportAt: null, health: null, keyId: null } }) as PullerState;

export type Trigger = { kind: "tick" } | { kind: "nudge"; by: string; sentAt: string | null; messageIds: string[] };

/** The Lambda event: EventBridge's `{ action: "tick" }`, or SQS records whose bodies are nudges. Anything else is a tick. */
export function parseTrigger(event: unknown): Trigger {
  const records = (event as { Records?: Array<{ body?: string; messageId?: string }> } | null)?.Records;
  if (Array.isArray(records) && records.length > 0) {
    let by = "unknown";
    let sentAt: string | null = null;
    const messageIds: string[] = [];
    for (const record of records) {
      if (record.messageId) messageIds.push(record.messageId);
      try {
        const body = JSON.parse(record.body ?? "{}") as { by?: unknown; at?: unknown };
        if (typeof body.by === "string" && body.by.trim()) by = body.by.trim().slice(0, 120);
        if (typeof body.at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.at)) sentAt = body.at;
      } catch {
        // A body that is not JSON is still a nudge: the queue's existence is the signal, its content is not trusted.
      }
    }
    return { kind: "nudge", by, sentAt, messageIds };
  }
  return { kind: "tick" };
}

export interface PullPlan {
  pull: boolean;
  reason: "tick" | "nudge" | "reseal" | "backoff";
  skipPointer: boolean;
  edge: PullEdgeState | null;
  nextPullAt: string | null;
}

/**
 * Whether to pull now. A nudge always pulls and skips the pointer (the origin is read once, conditionally). A key the
 * host published that the held generation is not sealed to is a re-seal: the origin is read unconditionally (the
 * manifest ETag is dropped so a 304 cannot stand in for the bundle). A tick inside the backoff window does nothing.
 */
export function planPull(input: { now: string; trigger: Trigger; state: PullerState; newest: ReleaseRow | null; keyId: string | null }): PullPlan {
  const { state, newest, keyId } = input;
  if (keyId && newest && newest.keyId !== keyId) return { pull: true, reason: "reseal", skipPointer: true, edge: state.edge ? { ...state.edge, manifestEtag: null } : null, nextPullAt: null };
  if (input.trigger.kind === "nudge") return { pull: true, reason: "nudge", skipPointer: true, edge: state.edge, nextPullAt: null };
  if (state.nextPullAt && Date.parse(state.nextPullAt) > Date.parse(input.now)) return { pull: false, reason: "backoff", skipPointer: false, edge: state.edge, nextPullAt: state.nextPullAt };
  return { pull: true, reason: "tick", skipPointer: false, edge: state.edge, nextPullAt: null };
}

const hourOf = (iso: string): string => iso.slice(0, 13);
/** EventBridge delivers a rate rule within a few seconds of the minute; a floor that lands after the tick would skip it. */
export const SCHEDULE_TOLERANCE_MS = 15_000;

/** The state after a result: the SDK's backoff, the edge it handed back, this hour's read counters. */
export function advance(state: PullerState, result: PullBundleResult, input: { now: string; intervalMs: number; capMs?: number; trigger: Trigger["kind"] | "reseal" }): PullerState {
  const hour = hourOf(input.now);
  const reads = state.reads.hour === hour ? { ...state.reads } : { hour, pointer: 0, origin: 0 };
  if (result.status === "unchanged" && result.via === "pointer") reads.pointer += 1;
  else reads.origin += 1;
  const unchangedStreak = result.status === "unchanged" ? state.unchangedStreak + 1 : 0;
  // The schedule is the interval: after a change, a refusal or an outage the next tick pulls (no floor — a tick that
  // arrives a few seconds early must not be skipped); after "unchanged" the SDK's stretched delay is the floor, less a
  // tolerance for the schedule's jitter. At the plan's five-minute rate the cap equals the tick and nothing is ever skipped.
  const delay = nextPullDelayMs({ outcome: result.status, unchangedStreak, intervalMs: input.intervalMs, capMs: input.capMs ?? 5 * 60_000 });
  const nextPullAt = result.status === "unchanged" ? new Date(Date.parse(input.now) + delay - SCHEDULE_TOLERANCE_MS).toISOString() : null;
  const lastPull: PullerState["lastPull"] = {
    at: input.now,
    outcome: result.status,
    via: result.status === "unchanged" ? result.via : null,
    reason: result.status === "refused" || result.status === "unavailable" ? result.reason : null,
    detail: (result.status === "refused" || result.status === "unavailable") && result.detail ? result.detail.slice(0, 200) : null,
    generation: result.status === "ok" ? result.generation : null,
    trigger: input.trigger,
  };
  return { ...state, edge: result.edge, unchangedStreak, nextPullAt, reads, lastPull };
}

/** `releases/<generation>-<key id's first 8>.apbundle`, or `…-plain.apbundle` for a dev plaintext bundle. */
export function objectKeyOf(prefix: string, generation: number, keyId: string | null): string {
  return `${prefix}${generation}-${keyId ? keyId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) : "plain"}.apbundle`;
}

/** The health the puller reports for itself: failing when the key is unreadable or the last pull was unavailable, degraded on a refusal. */
export function pullerHealth(input: { keyReadable: boolean; lastPull: PullerState["lastPull"]; newest: ReleaseRow | null }): { ok: boolean; status: "ok" | "degraded" | "failing"; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.keyReadable) reasons.push("agent_key_unreadable");
  if (input.lastPull?.outcome === "unavailable") reasons.push(`pull_unavailable:${input.lastPull.reason ?? "unknown"}`);
  if (input.lastPull?.outcome === "refused") reasons.push(`pull_refused:${input.lastPull.reason ?? "unknown"}`);
  if (!input.newest) reasons.push("nothing_pulled_yet");
  const status = reasons.some((r) => r === "agent_key_unreadable" || r.startsWith("pull_unavailable")) ? "failing" : reasons.length > 0 ? "degraded" : "ok";
  return { ok: status === "ok", status, reasons };
}
