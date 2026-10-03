/**
 * The puller's schedule, pure over what it knows: what woke it (the schedule, or a nudge from the queue), whether
 * the exchange holds a usable distribution public key, and its own state (the backoff, the nudge ids, what it
 * mirrored last). The release itself is not here — `pullToDatastore` keeps the edge state and every sealed
 * generation in the datastore. `planPull` says whether to call it this time (pointer-first on a tick, `skipPointer`
 * on a nudge) and stops on a malformed key rather than downgrading to plaintext. `advance` folds a result into the
 * backoff with the SDK's `nextPullDelayMs`, counted in ticks to skip.
 *
 * @example
 * ```ts
 * const plan = planPull({ now, trigger: { kind: "tick" }, state, key: { keyId, malformed: null } });
 * const result = await pullToDatastore({ datastore, region, skipPointer: plan.skipPointer, distributionPublicKey });
 * const next = advance(state, result, { now, intervalMs: 300_000, trigger: plan.reason });
 * ```
 */
import type { PullToDatastoreResult } from "@airprompter/agent-sdk";
import { nextPullDelayMs } from "@airprompter/agent-sdk";

/** What the puller remembers between ticks. The datastore holds the release and the edge; this is only the schedule. */
export interface PullerState {
  /** Consecutive "unchanged" results, and consecutive failures: each stretches the interval. */
  unchangedStreak: number;
  failureStreak: number;
  /** Ticks to let pass before the next pull (the stretched delay in ticks, less one); a nudge ignores it. */
  skipTicks: number;
  /** When the next scheduled pull is due, for the card; `skipTicks` is what decides. */
  nextPullAt: string | null;
  /** Reads this hour: pointer (a CDN read) and origin (an API read), for the card's cost line. */
  reads: { hour: string; pointer: number; origin: number };
  lastPull: { at: string; outcome: string; via: string | null; reason: string | null; detail: string | null; generation: number | null; trigger: string } | null;
  nudges: number;
  /** The last nudge messages counted (the queue may deliver one twice; a run that lost a race runs again): each id counts once. */
  nudgeIds: string[];
  /** What the puller mirrored last from the air-gapped host's status document. */
  airgap: { writtenAt: string | null; startedAt: string | null; lastAppliedAt: string | null; lastExportAt: string | null; health: string | null; keyId: string | null };
}

export const EMPTY_STATE: PullerState = Object.freeze({
  unchangedStreak: 0,
  failureStreak: 0,
  skipTicks: 0,
  nextPullAt: null,
  reads: { hour: "", pointer: 0, origin: 0 },
  lastPull: null,
  nudges: 0,
  nudgeIds: [],
  airgap: { writtenAt: null, startedAt: null, lastAppliedAt: null, lastExportAt: null, health: null, keyId: null },
}) as PullerState;
export const NUDGE_IDS_KEPT = 50;

/** The nudge counted once per message id: the state with the ids added, or null when every id was seen already. Pure. */
export function countNudge(state: PullerState, messageIds: string[]): PullerState | null {
  const unseen = messageIds.filter((id) => !state.nudgeIds.includes(id));
  if (unseen.length === 0 && messageIds.length > 0) return null;
  return { ...state, nudges: state.nudges + 1, nudgeIds: [...state.nudgeIds, ...unseen].slice(-NUDGE_IDS_KEPT) };
}

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

/** The exchange's public key as the puller read it: an id, or nothing, or something that is not a key (which stops the puller). */
export interface KeyInExchange {
  keyId: string | null;
  malformed: string | null;
}

export interface PullPlan {
  pull: boolean;
  reason: "tick" | "nudge" | "backoff" | "key_malformed";
  skipPointer: boolean;
  nextPullAt: string | null;
}

/**
 * Whether to pull now. A malformed key object stops the puller (never a quiet downgrade to plaintext). A nudge
 * always pulls and skips the pointer. A tick with ticks left to skip does nothing.
 */
export function planPull(input: { now: string; trigger: Trigger; state: PullerState; key: KeyInExchange }): PullPlan {
  const { state, key } = input;
  if (key.malformed) return { pull: false, reason: "key_malformed", skipPointer: false, nextPullAt: state.nextPullAt };
  if (input.trigger.kind === "nudge") return { pull: true, reason: "nudge", skipPointer: true, nextPullAt: null };
  if (state.skipTicks > 0) return { pull: false, reason: "backoff", skipPointer: false, nextPullAt: state.nextPullAt };
  return { pull: true, reason: "tick", skipPointer: false, nextPullAt: null };
}

const hourOf = (iso: string): string => iso.slice(0, 13);

/**
 * The state after a result. "Unchanged" and failures each stretch the interval with the SDK's rule; a change snaps it
 * back. The stretch is kept as ticks to skip, so at the plan's five-minute schedule (the SDK's cap) nothing is ever
 * skipped, and at the demo's one-minute schedule an idle puller reads the pointer every 1, 2, 4, 5, 5 … minutes.
 */
export function advance(state: PullerState, result: PullToDatastoreResult, input: { now: string; intervalMs: number; capMs?: number; trigger: Trigger["kind"] }): PullerState {
  const hour = hourOf(input.now);
  const reads = state.reads.hour === hour ? { ...state.reads } : { hour, pointer: 0, origin: 0 };
  if (result.status === "unchanged" && result.via === "pointer") reads.pointer += 1;
  else if (result.status === "datastore_unavailable") {
    // The datastore could not be read or written: that is not a read of AirPrompter.
  } else if (!(result.status === "refused" && result.reason === "plaintext_not_allowed")) reads.origin += 1;
  const asked = input.trigger === "nudge";
  const quiet = result.status === "unchanged" || result.status === "ok";
  const unchangedStreak = result.status === "unchanged" && !asked ? state.unchangedStreak + 1 : 0;
  const failureStreak = quiet ? 0 : asked ? 1 : state.failureStreak + 1;
  const delay = result.status === "ok" || asked ? input.intervalMs : nextPullDelayMs({ outcome: "unchanged", unchangedStreak: Math.max(unchangedStreak, failureStreak), intervalMs: input.intervalMs, capMs: input.capMs ?? 5 * 60_000 });
  const skipTicks = Math.max(0, Math.round(delay / input.intervalMs) - 1);
  const nextPullAt = skipTicks > 0 ? new Date(Date.parse(input.now) + (skipTicks + 1) * input.intervalMs).toISOString() : null;
  const reason = result.status === "refused" || result.status === "unavailable" ? result.reason : result.status === "nothing_promoted" ? "nothing_promoted" : result.status === "datastore_unavailable" ? result.stage : null;
  const detail = result.status === "datastore_unavailable" ? result.detail : (result.status === "refused" || result.status === "unavailable") && result.detail ? result.detail.slice(0, 200) : null;
  const lastPull: PullerState["lastPull"] = {
    at: input.now,
    outcome: result.status,
    via: result.status === "unchanged" ? result.via : null,
    reason,
    detail,
    generation: result.status === "ok" ? result.generation : null,
    trigger: input.trigger,
  };
  return { ...state, unchangedStreak, failureStreak, skipTicks, nextPullAt, reads, lastPull };
}

/** The health the puller reports for itself. */
export function pullerHealth(input: { keyReadable: boolean; lastPull: PullerState["lastPull"]; newestGeneration: number | null; key: KeyInExchange; airgapStatus?: string | null }): { ok: boolean; status: "ok" | "degraded" | "failing"; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.keyReadable) reasons.push("agent_key_unreadable");
  if (input.key.malformed) reasons.push(input.key.malformed.startsWith("denied:") ? `public_key_unreadable:${input.key.malformed.slice(7, 60)}` : `public_key_malformed:${input.key.malformed.slice(0, 60)}`);
  if (input.airgapStatus) reasons.push(`airgap_status_unreadable:${input.airgapStatus.slice(0, 40)}`);
  if (input.lastPull?.outcome === "unavailable" || input.lastPull?.outcome === "datastore_unavailable") reasons.push(`pull_unavailable:${input.lastPull.reason ?? "unknown"}`);
  if (input.lastPull?.outcome === "refused") reasons.push(`pull_refused:${input.lastPull.reason ?? "unknown"}`);
  if (input.lastPull?.outcome === "nothing_promoted") reasons.push("nothing_promoted");
  if (input.newestGeneration == null) reasons.push("nothing_pulled_yet");
  const status = reasons.some((r) => r === "agent_key_unreadable" || r.startsWith("pull_unavailable")) ? "failing" : reasons.length > 0 ? "degraded" : "ok";
  return { ok: status === "ok", status, reasons };
}
