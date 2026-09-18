/**
 * The puller's decisions, pure over what it knows: what woke it (the schedule, or a nudge from the queue), what the
 * table holds (the newest generation and which key it is sealed to), what the exchange holds (the air-gapped host's
 * public key, when one has been published — or a malformed object, which stops the puller rather than downgrading
 * it to plaintext) and its own state row (the edge pointer's ETags, the backoff, the read counters). `planPull` says
 * whether to call `pullBundle` this time and how — pointer-first on a tick, `skipPointer` on a nudge, and a re-pull
 * to seal the held generation to a key the host published since (given up after a few failures until the key
 * changes) — and `advance` folds a result back into the state: the SDK's `nextPullDelayMs` stretches the interval
 * while nothing changes or while every pull fails, counted in ticks to skip (a schedule's jitter cannot skip a tick
 * by accident) and snapped back on a change; the edge state is taken only from a result that hands one back.
 *
 * @example
 * ```ts
 * const plan = planPull({ now, trigger: { kind: "tick" }, state, newest, key: { keyId, malformed: null } });   // { pull: true, reason: "tick", skipPointer: false, edge }
 * const result = await pullBundle({ …, edge: plan.edge, skipPointer: plan.skipPointer, distributionPublicKey });
 * const next = advance(state, result, { now, intervalMs: 300_000, trigger: plan.reason, keyId });          // streaks, skipTicks, reads
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
  /** Consecutive "unchanged" results, and consecutive failures (refused, unavailable, nothing promoted): each stretches the interval. */
  unchangedStreak: number;
  failureStreak: number;
  /** Ticks to let pass before the next pull (the stretched delay in ticks, less one); a nudge or a re-seal ignores it. */
  skipTicks: number;
  /** When the next scheduled pull is due, for the card; `skipTicks` is what decides. */
  nextPullAt: string | null;
  /** Reads this hour: pointer (a CDN read) and origin (an API read), for the card's cost line. */
  reads: { hour: string; pointer: number; origin: number };
  lastPull: { at: string; outcome: string; via: string | null; reason: string | null; detail: string | null; generation: number | null; trigger: string } | null;
  nudges: number;
  /** Re-seals that failed for a key: after `RESEAL_MAX_FAILURES` the puller stops trying until the key changes. */
  reseal: { keyId: string; failures: number } | null;
  /** What the puller mirrored last from the air-gapped host's status document. */
  airgap: { writtenAt: string | null; startedAt: string | null; lastAppliedAt: string | null; lastExportAt: string | null; health: string | null; keyId: string | null };
}

export const EMPTY_STATE: PullerState = Object.freeze({ edge: null, unchangedStreak: 0, failureStreak: 0, skipTicks: 0, nextPullAt: null, reads: { hour: "", pointer: 0, origin: 0 }, lastPull: null, nudges: 0, reseal: null, airgap: { writtenAt: null, startedAt: null, lastAppliedAt: null, lastExportAt: null, health: null, keyId: null } }) as PullerState;
export const RESEAL_MAX_FAILURES = 3;

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
  reason: "tick" | "nudge" | "reseal" | "backoff" | "key_malformed";
  skipPointer: boolean;
  edge: PullEdgeState | null;
  nextPullAt: string | null;
}

/** Whether the held generation needs sealing to the key in the exchange, and the puller has not given up on that key. */
export function resealNeeded(state: PullerState, newest: ReleaseRow | null, keyId: string | null): boolean {
  if (!keyId || !newest || newest.keyId === keyId) return false;
  return !(state.reseal?.keyId === keyId && state.reseal.failures >= RESEAL_MAX_FAILURES);
}

/**
 * Whether to pull now. A malformed key object stops the puller (never a quiet downgrade to plaintext). A key the host
 * published that the held generation is not sealed to is a re-seal: the origin is read unconditionally (the manifest
 * ETag is dropped so a 304 cannot stand in for the bundle). A nudge always pulls and skips the pointer. A tick with
 * ticks left to skip does nothing.
 */
export function planPull(input: { now: string; trigger: Trigger; state: PullerState; newest: ReleaseRow | null; key: KeyInExchange }): PullPlan {
  const { state, newest, key } = input;
  if (key.malformed) return { pull: false, reason: "key_malformed", skipPointer: false, edge: state.edge, nextPullAt: state.nextPullAt };
  if (resealNeeded(state, newest, key.keyId)) return { pull: true, reason: "reseal", skipPointer: true, edge: state.edge ? { ...state.edge, manifestEtag: null } : null, nextPullAt: null };
  if (input.trigger.kind === "nudge") return { pull: true, reason: "nudge", skipPointer: true, edge: state.edge, nextPullAt: null };
  if (state.skipTicks > 0) return { pull: false, reason: "backoff", skipPointer: false, edge: state.edge, nextPullAt: state.nextPullAt };
  return { pull: true, reason: "tick", skipPointer: false, edge: state.edge, nextPullAt: null };
}

const hourOf = (iso: string): string => iso.slice(0, 13);

/**
 * The state after a result. "Unchanged" and failures each stretch the interval with the SDK's rule; a change snaps it
 * back. The stretch is kept as ticks to skip, so at the plan's five-minute schedule (the SDK's cap) nothing is ever
 * skipped, and at the demo's one-minute schedule an idle puller reads the pointer every 1, 2, 4, 5, 5 … minutes.
 */
export function advance(state: PullerState, result: PullBundleResult, input: { now: string; intervalMs: number; capMs?: number; trigger: Trigger["kind"] | "reseal"; keyId: string | null }): PullerState {
  const hour = hourOf(input.now);
  const reads = state.reads.hour === hour ? { ...state.reads } : { hour, pointer: 0, origin: 0 };
  if (result.status === "unchanged" && result.via === "pointer") reads.pointer += 1;
  // A refusal the SDK gives before any network call (plaintext on a non-dev target) is not a read.
  else if (!(result.status === "refused" && result.reason === "plaintext_not_allowed")) reads.origin += 1;
  const unchangedStreak = result.status === "unchanged" ? state.unchangedStreak + 1 : 0;
  const failureStreak = result.status === "ok" || result.status === "unchanged" ? 0 : state.failureStreak + 1;
  const delay = result.status === "ok" ? input.intervalMs : nextPullDelayMs({ outcome: "unchanged", unchangedStreak: Math.max(unchangedStreak, failureStreak), intervalMs: input.intervalMs, capMs: input.capMs ?? 5 * 60_000 });
  const skipTicks = result.status === "ok" ? 0 : Math.max(0, Math.round(delay / input.intervalMs) - 1);
  const nextPullAt = skipTicks > 0 ? new Date(Date.parse(input.now) + skipTicks * input.intervalMs).toISOString() : null;
  const lastPull: PullerState["lastPull"] = {
    at: input.now,
    outcome: result.status,
    via: result.status === "unchanged" ? result.via : null,
    reason: result.status === "refused" || result.status === "unavailable" ? result.reason : result.status === "nothing_promoted" ? "nothing_promoted" : null,
    detail: (result.status === "refused" || result.status === "unavailable") && result.detail ? result.detail.slice(0, 200) : null,
    generation: result.status === "ok" ? result.generation : null,
    trigger: input.trigger,
  };
  let reseal = state.reseal;
  if (input.trigger === "reseal" && input.keyId) {
    reseal = result.status === "ok" ? null : { keyId: input.keyId, failures: state.reseal?.keyId === input.keyId ? state.reseal.failures + 1 : 1 };
  }
  return { ...state, edge: result.edge, unchangedStreak, failureStreak, skipTicks, nextPullAt, reads, lastPull, reseal };
}

/** `releases/<generation>-<digest's first 8>-<key id's first 8>.apbundle` (`plain` for a dev plaintext bundle): one object per generation, digest and recipient. */
export function objectKeyOf(prefix: string, generation: number, releaseDigest: string, keyId: string | null): string {
  const safe = (value: string): string => value.replace(/^sha256:/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return `${prefix}${generation}-${safe(releaseDigest)}-${keyId ? safe(keyId) : "plain"}.apbundle`;
}

/** The health the puller reports for itself: failing when the key is unreadable or the last pull was unavailable, degraded on a refusal, a malformed key object or a re-seal given up. */
export function pullerHealth(input: { keyReadable: boolean; lastPull: PullerState["lastPull"]; newest: ReleaseRow | null; key: KeyInExchange; reseal: PullerState["reseal"] }): { ok: boolean; status: "ok" | "degraded" | "failing"; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.keyReadable) reasons.push("agent_key_unreadable");
  if (input.key.malformed) reasons.push(`public_key_malformed:${input.key.malformed.slice(0, 60)}`);
  if (input.lastPull?.outcome === "unavailable") reasons.push(`pull_unavailable:${input.lastPull.reason ?? "unknown"}`);
  if (input.lastPull?.outcome === "refused") reasons.push(`pull_refused:${input.lastPull.reason ?? "unknown"}`);
  if (input.lastPull?.outcome === "nothing_promoted") reasons.push("nothing_promoted");
  if (input.reseal && input.reseal.failures >= RESEAL_MAX_FAILURES && input.reseal.keyId === input.key.keyId) reasons.push(`reseal_failing:${input.reseal.keyId.slice(0, 8)}`);
  if (!input.newest) reasons.push("nothing_pulled_yet");
  const status = reasons.some((r) => r === "agent_key_unreadable" || r.startsWith("pull_unavailable")) ? "failing" : reasons.length > 0 ? "degraded" : "ok";
  return { ok: status === "ok", status, reasons };
}
