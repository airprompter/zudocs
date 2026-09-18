/**
 * The approvals watcher: the host's side of "you activate, not us". The daemon runs the apply policy and stages a
 * release under `unlock_required`; a process attached to it never receives the `apply.onStaged` hook (the hook runs
 * inside the process that syncs — an SDK gap we filed), so this watcher reads what the daemon reports instead.
 * Each tick it compares the staged generation with what it last saw:
 *
 * - a newly staged generation opens one approval row (`pending`) and writes a `release_staged` event;
 * - a row the owner `approved` on the desk makes the watcher call `unlock()` — host-wide through the daemon — and
 *   settle the row `activated` (or `failed`, with the SDK's reason), with a `release_activated` event;
 * - a staged generation that vanished without the watcher's unlock (an operator's `airprompter unlock` on the shell,
 *   an update window, a rollback) settles the row `superseded` and says which generation is live.
 *
 * Idempotent by construction: the row's id is the host and the generation, `open` creates it at most once, the
 * desk's approve flips it at most once, and a watcher restarted mid-way finds the row where it left it. Pure over
 * its ports, so a test drives it with a fake store and a scripted daemon.
 *
 * @example
 * ```ts
 * const watcher = new ApprovalWatcher({ hostId, store, status: () => ap.status(), unlock: () => ap.unlock(), now, log });
 * setInterval(() => void watcher.tick(), 5000);
 * ```
 */
import type { ApprovalRow, Store } from "../../desk-api/src/store.js";
import { approvalIdOf } from "../../desk-api/src/store.js";

export interface WatcherPorts {
  hostId: string;
  store: Pick<Store, "openApproval" | "getApproval" | "settleApproval" | "listApprovals" | "appendEvent">;
  /** The attached SDK's status: the staged and active generations as the daemon reports them. */
  status: () => { generation: number; stagedGeneration: number | null; unlockRequests: ApprovalRow["unlockRequest"][] };
  /** The daemon's own status, for the staged release's digest when it names one; null when unreachable. */
  daemonStatus?: () => Promise<{ releaseDigest?: string | null } | null>;
  /** `ap.unlock()`: host-wide through the daemon; `{ generation }` when something activated, null when nothing was staged. */
  unlock: () => Promise<{ generation: number } | null>;
  now: () => string;
  log: (event: Record<string, unknown>) => void;
}

export type WatcherAction = "opened" | "activated" | "failed" | "superseded" | "waiting" | "idle";

export class ApprovalWatcher {
  /** The row this watcher is currently minding. */
  private open: { approvalId: string; generation: number } | null = null;
  private ticking: Promise<WatcherAction> | null = null;

  constructor(private readonly ports: WatcherPorts) {}

  get current(): { approvalId: string; generation: number } | null {
    return this.open;
  }

  /** On start: rows of this host left `pending` or `approved` for a generation that is no longer staged are settled. */
  async reconcile(): Promise<number> {
    const { hostId, store, status, now } = this.ports;
    const staged = status().stagedGeneration;
    let settled = 0;
    for (const row of await store.listApprovals(50)) {
      if (row.hostId !== hostId || (row.decision !== "pending" && row.decision !== "approved")) continue;
      if (staged === row.generation) continue;
      const live = status().generation;
      const outcome = `settled at start: generation ${row.generation} is no longer staged on this host (generation ${live} is live)`;
      if (await store.settleApproval(row.approvalId, { decision: "superseded", outcome, at: now() })) settled += 1;
    }
    return settled;
  }

  /** One pass; never throws (a failure is logged and the next tick tries again). Overlapping ticks share one pass. */
  tick(): Promise<WatcherAction> {
    if (this.ticking) return this.ticking;
    this.ticking = this.pass()
      .catch((error: unknown) => {
        this.ports.log({ event: "approval_watcher_failed", reason: (error as Error).message.slice(0, 300) });
        return "idle" as const;
      })
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async pass(): Promise<WatcherAction> {
    const { hostId, store, status, unlock, now, log } = this.ports;
    const s = status();
    const staged = s.stagedGeneration;
    if (staged === null) {
      if (!this.open) return "idle";
      // The staged release went live (or away) without this watcher: an operator's unlock, a window, a rollback.
      const live = s.generation;
      const wentLive = live >= this.open.generation;
      const outcome = wentLive ? `activated on the host without the desk (airprompter unlock, a window, or another process): generation ${live} is live` : `no longer staged: generation ${live} is live`;
      const at = now();
      const row = await store.settleApproval(this.open.approvalId, { decision: "superseded", outcome, at, activatedAt: wentLive ? at : null });
      if (row) await store.appendEvent({ at, kind: wentLive ? "release_activated" : "release_unstaged", host: hostId, generation: live, approvalId: this.open.approvalId, by: "host", outcome });
      log({ event: "approval_superseded", approvalId: this.open.approvalId, generation: live });
      this.open = null;
      return "superseded";
    }
    const approvalId = approvalIdOf(hostId, staged);
    if (this.open?.approvalId !== approvalId) {
      const at = now();
      const digest = (await this.ports.daemonStatus?.().catch(() => null))?.releaseDigest ?? null;
      const request = s.unlockRequests.find((r) => r !== null) ?? null;
      const row: ApprovalRow = { approvalId, hostId, generation: staged, releaseDigest: digest, stagedAt: at, unlockRequest: request, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: at };
      const { created } = await store.openApproval(row);
      this.open = { approvalId, generation: staged };
      if (created) {
        await store.appendEvent({ at, kind: "release_staged", host: hostId, generation: staged, approvalId, policy: "unlock_required", note: request?.note ?? null });
        log({ event: "approval_opened", approvalId, generation: staged });
        return "opened";
      }
      log({ event: "approval_resumed", approvalId, generation: staged });
    }
    const row = await store.getApproval(approvalId);
    if (!row || row.decision !== "approved") return "waiting";
    try {
      const result = await unlock();
      const at = now();
      if (!result) {
        // Nothing was staged by the time the daemon looked: the next tick reads the new state and settles the row.
        log({ event: "approval_unlock_nothing_staged", approvalId });
        return "waiting";
      }
      const outcome = `activated through the daemon on the desk's approval by ${row.decidedBy ?? "the owner"}`;
      await store.settleApproval(approvalId, { decision: "activated", outcome, activatedAt: at, at });
      await store.appendEvent({ at, kind: "release_activated", host: hostId, generation: result.generation, approvalId, by: row.decidedBy ?? "the owner", decidedAt: row.decidedAt, outcome });
      log({ event: "approval_activated", approvalId, generation: result.generation });
      this.open = null;
      return "activated";
    } catch (error) {
      const at = now();
      const reason = (error as Error).message.slice(0, 300);
      await store.settleApproval(approvalId, { decision: "failed", outcome: `the unlock was refused: ${reason}`, at });
      await store.appendEvent({ at, kind: "approval_failed", host: hostId, generation: staged, approvalId, reason });
      log({ event: "approval_unlock_failed", approvalId, reason });
      // `open` stays: the row is settled `failed` and is not re-opened while this generation is still staged; an
      // operator's unlock on the host (or the next promotion) moves it on through the superseded path above.
      return "failed";
    }
  }
}
