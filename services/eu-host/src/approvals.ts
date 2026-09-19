/**
 * The approvals watcher: the host's side of "you activate, not us". The daemon runs the apply policy and stages a
 * release under `unlock_required`; a process attached to it never receives the `apply.onStaged` hook (the hook runs
 * inside the process that syncs — an SDK gap we filed), so this watcher reads what the daemon reports over its
 * socket instead — and it runs over that plain socket client, not over an attached SDK, because on a fresh store
 * the very first release lands staged and an SDK cannot attach until something is active. Each tick it compares
 * the staged generation with what it last saw:
 *
 * - a newly staged generation opens one approval row (`pending`) and writes a `release_staged` event;
 * - a row the owner `approved` on the desk makes the watcher call the daemon's `unlock` — host-wide, every attached
 *   SDK switches — and settle the row `activated` (or `failed`, when the daemon *refused* with a store reason; a
 *   socket that is closed or absent is transient and the row stays `approved` for the next tick);
 * - a staged generation that vanished without the watcher's unlock (an operator's `airprompter unlock` on the shell,
 *   an update window, a rollback) settles the row `superseded` and says which generation is live;
 * - a staged generation replaced by a newer one (the next promotion landed while the row was open) settles the old
 *   row `superseded` — it is no longer what the host would activate — and opens the newer generation's row.
 *
 * The row's id is the host, the generation *and the store* the daemon serves from (`hello.storeId`): a replaced
 * instance stages the same generation again on a fresh store and gets a fresh row, while a restarted watcher on the
 * same store resumes its row. `open` creates a row at most once, the desk's approve flips it at most once. Pure over
 * its ports, so a test drives it with a fake store and a scripted daemon.
 *
 * @example
 * ```ts
 * const watcher = new ApprovalWatcher({ hostId, storeId: () => client.hello.storeId, store, status: () => latest, unlock: () => client.request("unlock"), now, log });
 * setInterval(() => void watcher.tick(), 5000);
 * ```
 */
import type { ApprovalRow, Store } from "../../desk-api/src/store.js";
import { approvalIdOf } from "../../desk-api/src/store.js";

export interface WatcherPorts {
  hostId: string;
  /** The daemon's store id (`hello.storeId`) as of now, part of the row's id: a fresh store is a fresh row. */
  storeId: () => string;
  store: Pick<Store, "openApproval" | "getApproval" | "settleApproval" | "listApprovals" | "appendEvent">;
  /**
   * The daemon's latest status: the staged and active generations (read over the socket before each tick) — or
   * null when the daemon did not answer (a restart): then nothing is known and nothing is touched.
   */
  status: () => { generation: number; stagedGeneration: number | null; unlockRequests: ApprovalRow["unlockRequest"][] } | null;
  /**
   * The daemon's `unlock` op: `{ generation }` when something activated, null when nothing was staged. Throws a
   * `DaemonError`: `refused` (with the store's reason) is final; anything else is transient.
   */
  unlock: () => Promise<{ generation: number } | null>;
  /** Whether an error from `unlock` is the daemon's refusal (final) rather than a lost socket (transient). */
  isRefusal?: (error: unknown) => boolean;
  now: () => string;
  log: (event: Record<string, unknown>) => void;
}

export type WatcherAction = "opened" | "activated" | "failed" | "superseded" | "waiting" | "transient" | "unreachable" | "idle";

export class ApprovalWatcher {
  /** The row this watcher is currently minding, and the store it was opened on. */
  private open: { approvalId: string; generation: number; storeId: string } | null = null;
  private ticking: Promise<WatcherAction> | null = null;

  constructor(private readonly ports: WatcherPorts) {}

  get current(): { approvalId: string; generation: number; storeId: string } | null {
    return this.open;
  }

  /** The pass in flight, for a shutdown that wants to let it settle. */
  get inFlight(): Promise<WatcherAction> | null {
    return this.ticking;
  }

  /**
   * On start: rows of this host left `pending` or `approved` that are not the generation now staged on this store
   * — an older generation, or any generation of a previous store (a replaced instance) — are settled. With the
   * daemon unreachable nothing is known and nothing is settled (-1).
   */
  async reconcile(): Promise<number> {
    const { hostId, store, status, now } = this.ports;
    const s = status();
    if (!s) return -1;
    const storeId = this.ports.storeId();
    let settled = 0;
    for (const row of await store.listApprovals(50)) {
      if (row.hostId !== hostId || (row.decision !== "pending" && row.decision !== "approved")) continue;
      if (row.storeId === storeId && s.stagedGeneration === row.generation) continue;
      const outcome = row.storeId === storeId
        ? `settled at start: generation ${row.generation} is no longer staged on this host (generation ${s.generation} is live)`
        : `settled at start: the host's store was replaced (a new instance); generation ${s.generation} is live and any staged release has its own row`;
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
    // The daemon did not answer (it restarts on every key refresh): nothing is known, so nothing is settled or opened.
    if (!s) return "unreachable";
    const storeId = this.ports.storeId();
    if (this.open && this.open.storeId !== storeId) {
      // The store under the daemon was replaced while this watcher ran: the row it minded belongs to the old store.
      const at = now();
      await store.settleApproval(this.open.approvalId, { decision: "superseded", outcome: `the host's store was replaced under the daemon; generation ${s.generation} is live and any staged release has its own row`, at });
      log({ event: "approval_store_replaced", approvalId: this.open.approvalId, storeId });
      this.open = null;
    }
    const staged = s.stagedGeneration;
    if (staged === null) {
      if (!this.open) return "idle";
      // The staged release went live (or away) without this watcher: an operator's unlock, a window, a rollback.
      const live = s.generation;
      const wentLive = live >= this.open.generation;
      const outcome = wentLive ? `activated on the host without the desk's decision (airprompter unlock, a window, or another process): generation ${live} is live` : `no longer staged: generation ${live} is live`;
      const at = now();
      const row = await store.settleApproval(this.open.approvalId, { decision: "superseded", outcome, at, activatedAt: wentLive ? at : null });
      if (row) await store.appendEvent({ at, kind: wentLive ? "release_activated" : "release_unstaged", host: hostId, generation: live, approvalId: this.open.approvalId, by: "host", outcome });
      log({ event: "approval_superseded", approvalId: this.open.approvalId, generation: live });
      this.open = null;
      return "superseded";
    }
    const approvalId = approvalIdOf(hostId, staged, storeId);
    if (this.open && this.open.approvalId !== approvalId) {
      // The daemon staged something newer while this row was open (the next promotion landed): the row's generation
      // is no longer what an unlock would activate, so it is settled — a later click on it must not approve it.
      const at = now();
      const outcome = `superseded: generation ${staged} is staged in its place (generation ${s.generation} is live); the newer generation has its own row`;
      const row = await store.settleApproval(this.open.approvalId, { decision: "superseded", outcome, at });
      if (row) await store.appendEvent({ at, kind: "release_unstaged", host: hostId, generation: s.generation, approvalId: this.open.approvalId, by: "host", outcome, replacedBy: staged });
      log({ event: "approval_superseded", approvalId: this.open.approvalId, generation: s.generation, replacedBy: staged });
      this.open = null;
    }
    if (this.open?.approvalId !== approvalId) {
      const at = now();
      const request = s.unlockRequests.find((r) => r !== null) ?? null;
      const row: ApprovalRow = { approvalId, hostId, storeId, generation: staged, releaseDigest: null, stagedAt: at, unlockRequest: request, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: at };
      const { created } = await store.openApproval(row);
      this.open = { approvalId, generation: staged, storeId };
      if (created) {
        await store.appendEvent({ at, kind: "release_staged", host: hostId, generation: staged, approvalId, policy: "unlock_required", note: request?.note ?? null });
        log({ event: "approval_opened", approvalId, generation: staged });
        return "opened";
      }
      log({ event: "approval_resumed", approvalId, generation: staged });
    }
    const row = await store.getApproval(approvalId);
    if (!row || row.decision !== "approved") return "waiting";
    let result: { generation: number } | null;
    try {
      result = await unlock();
    } catch (error) {
      const reason = (error as Error).message.slice(0, 300);
      if (!(this.ports.isRefusal?.(error) ?? false)) {
        // The socket is closed or the daemon is restarting: the decision stands and the next tick tries again.
        log({ event: "approval_unlock_transient", approvalId, reason });
        return "transient";
      }
      const at = now();
      await store.settleApproval(approvalId, { decision: "failed", outcome: `the daemon refused the unlock: ${reason}`, at });
      await store.appendEvent({ at, kind: "approval_failed", host: hostId, generation: staged, approvalId, reason });
      log({ event: "approval_unlock_failed", approvalId, reason });
      // `open` stays: the row is settled `failed` and is not re-opened while this generation is staged on this
      // store; an operator's unlock on the host (or the next promotion) moves it on through the superseded path.
      return "failed";
    }
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
  }
}
