/**
 * The approvals watcher against a fake store and a scripted daemon: a staged generation opens one row, a decision
 * unlocks through the daemon and settles the row, a restart resumes the same row, a replaced store (a new instance
 * staging the same generation) gets a fresh row and the old one is settled, an unlock on the host's shell is seen
 * and settled as superseded, a lost socket during an unlock is transient (the decision stands), a refused unlock is
 * `failed` once and not retried in a loop, two ticks at once share one pass, and a failure inside a pass never
 * throws out of `tick()`.
 *
 * @example
 * ```sh
 * npx tsx --test test/approvals.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalRow, TimelineEvent } from "../../desk-api/src/store.js";
import { ApprovalWatcher, type WatcherPorts } from "../src/approvals.js";

class Refusal extends Error {
  constructor(readonly reason: string) {
    super(`store: ${reason}`);
  }
}

function harness(options: { unlock?: () => Promise<{ generation: number } | null>; storeId?: string } = {}) {
  const rows = new Map<string, ApprovalRow>();
  const events: TimelineEvent[] = [];
  const logs: Record<string, unknown>[] = [];
  const daemon = { generation: 1, staged: null as number | null };
  let clock = 0;
  const now = () => `2026-09-18T15:00:${String(clock++).padStart(2, "0")}.000Z`;
  const store: WatcherPorts["store"] = {
    openApproval: async (row) => {
      const existing = rows.get(row.approvalId);
      if (existing && !["superseded", "failed"].includes(existing.decision)) return { created: false };
      rows.set(row.approvalId, { ...row });
      return { created: true };
    },
    getApproval: async (id) => rows.get(id) ?? null,
    listApprovals: async () => [...rows.values()],
    settleApproval: async (id, settle) => {
      const row = rows.get(id);
      if (!row || !["pending", "approved"].includes(row.decision)) return null;
      Object.assign(row, { decision: settle.decision, outcome: settle.outcome, activatedAt: settle.activatedAt ?? null, updatedAt: settle.at });
      return row;
    },
    appendEvent: async (event) => void events.push(event),
  };
  const unlocks: number[] = [];
  const ports = (storeId: string, unlock: WatcherPorts["unlock"], log: WatcherPorts["log"] = (event) => void logs.push(event)): WatcherPorts => ({
    hostId: "eu-west-1/ec2",
    storeId,
    store,
    status: () => ({ generation: daemon.generation, stagedGeneration: daemon.staged, unlockRequests: [] }),
    unlock,
    isRefusal: (error) => error instanceof Refusal,
    now,
    log,
  });
  const defaultUnlock = async () => {
    if (daemon.staged === null) return null;
    unlocks.push(daemon.staged);
    daemon.generation = daemon.staged;
    daemon.staged = null;
    return { generation: daemon.generation };
  };
  const watcher = new ApprovalWatcher(ports(options.storeId ?? "i-store1", options.unlock ?? defaultUnlock));
  return { rows, events, logs, daemon, watcher, unlocks, store, ports, defaultUnlock };
}

const ID = "eu-west-1-ec2-g2-i-store1";

test("a staged generation opens one pending row (host, generation, store) and one release_staged event; ticks while pending change nothing", async () => {
  const h = harness();
  assert.equal(await h.watcher.tick(), "idle");
  h.daemon.staged = 2;
  assert.equal(await h.watcher.tick(), "opened");
  const row = h.rows.get(ID)!;
  assert.equal(row.decision, "pending");
  assert.equal(row.generation, 2);
  assert.equal(row.hostId, "eu-west-1/ec2");
  assert.equal(row.storeId, "i-store1");
  assert.deepEqual(h.events.map((e) => e.kind), ["release_staged"]);
  assert.equal(await h.watcher.tick(), "waiting");
  assert.equal(await h.watcher.tick(), "waiting");
  assert.equal(h.events.length, 1, "no event per tick");
  assert.deepEqual(h.watcher.current, { approvalId: ID, generation: 2 });
});

test("the owner's approval makes the watcher unlock through the daemon, settle the row activated and write release_activated with the decider", async () => {
  const h = harness();
  h.daemon.staged = 2;
  await h.watcher.tick();
  Object.assign(h.rows.get(ID)!, { decision: "approved", decidedBy: "seth@zudocs.com", decidedAt: "2026-09-18T15:05:00.000Z" });
  assert.equal(await h.watcher.tick(), "activated");
  assert.deepEqual(h.unlocks, [2]);
  const row = h.rows.get(ID)!;
  assert.equal(row.decision, "activated");
  assert.match(row.outcome!, /approval by seth@zudocs.com/);
  assert.ok(row.activatedAt);
  const activated = h.events.find((e) => e.kind === "release_activated")!;
  assert.equal(activated.generation, 2);
  assert.equal(activated.by, "seth@zudocs.com");
  assert.equal(activated.approvalId, ID);
  assert.equal(h.watcher.current, null);
  assert.equal(await h.watcher.tick(), "idle", "nothing staged, nothing minded");
});

test("a restarted watcher on the same store resumes the existing row (no second row, no second event) and acts on its decision", async () => {
  const h = harness();
  h.daemon.staged = 3;
  await h.watcher.tick();
  const again = new ApprovalWatcher(h.ports("i-store1", async () => { h.daemon.generation = 3; h.daemon.staged = null; return { generation: 3 }; }, () => undefined));
  assert.equal(await again.tick(), "waiting", "resumed, still pending");
  assert.equal(h.rows.size, 1);
  assert.equal(h.events.filter((e) => e.kind === "release_staged").length, 1);
  Object.assign(h.rows.get("eu-west-1-ec2-g3-i-store1")!, { decision: "approved", decidedBy: "seth@zudocs.com" });
  assert.equal(await again.tick(), "activated");
});

test("a replaced instance (a fresh store) staging a generation the old store already activated gets its own pending row; reconcile settles the old store's open rows", async () => {
  const h = harness();
  h.daemon.staged = 2;
  await h.watcher.tick();
  Object.assign(h.rows.get(ID)!, { decision: "approved", decidedBy: "seth@zudocs.com" });
  assert.equal(await h.watcher.tick(), "activated");
  // Another row the old store left approved but unsettled (the worker died mid-unlock), and one pending.
  h.rows.set("eu-west-1-ec2-g3-i-store1", { approvalId: "eu-west-1-ec2-g3-i-store1", hostId: "eu-west-1/ec2", storeId: "i-store1", generation: 3, releaseDigest: null, stagedAt: "x", unlockRequest: null, decision: "approved", decidedBy: "seth@zudocs.com", decidedAt: "x", activatedAt: null, outcome: null, updatedAt: "x" });
  // The new instance: a fresh store, generation 2 staged again (a fresh store holds nothing, so the first release lands staged).
  h.daemon.generation = 0;
  h.daemon.staged = 2;
  const fresh = new ApprovalWatcher(h.ports("i-store2", h.defaultUnlock));
  assert.equal(await fresh.reconcile(), 1, "the old store's approved-but-unsettled row is settled");
  assert.equal(h.rows.get("eu-west-1-ec2-g3-i-store1")!.decision, "superseded");
  assert.match(h.rows.get("eu-west-1-ec2-g3-i-store1")!.outcome!, /store was replaced/);
  assert.equal(await fresh.tick(), "opened", "generation 2 on the new store is a new row, not the old activated one");
  const row = h.rows.get("eu-west-1-ec2-g2-i-store2")!;
  assert.equal(row.decision, "pending");
  assert.equal(h.rows.get(ID)!.decision, "activated", "the old store's row is untouched");
  Object.assign(row, { decision: "approved", decidedBy: "seth@zudocs.com" });
  assert.equal(await fresh.tick(), "activated");
  assert.equal(h.daemon.generation, 2);
});

test("reconcile at start settles rows left pending or approved for a generation no longer staged on this store; rows of other hosts are untouched", async () => {
  const h = harness();
  const row = (id: string, storeId: string, generation: number, hostId = "eu-west-1/ec2"): ApprovalRow => ({ approvalId: id, hostId, storeId, generation, releaseDigest: null, stagedAt: "x", unlockRequest: null, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: "x" });
  h.rows.set("a", row("a", "i-store1", 2));
  h.rows.set("b", row("b", "i-store1", 3));
  h.rows.set("c", row("c", "i-store1", 2, "other/host"));
  h.daemon.generation = 2;
  h.daemon.staged = 3;
  assert.equal(await h.watcher.reconcile(), 1);
  assert.equal(h.rows.get("a")!.decision, "superseded");
  assert.equal(h.rows.get("b")!.decision, "pending", "the generation still staged on this store keeps its row");
  assert.equal(h.rows.get("c")!.decision, "pending", "another host's row is not this watcher's");
});

test("an unlock on the host's shell (the staged generation went live without the desk) settles the row superseded with a release_activated by the host", async () => {
  const h = harness();
  h.daemon.staged = 2;
  await h.watcher.tick();
  h.daemon.generation = 2;
  h.daemon.staged = null;
  assert.equal(await h.watcher.tick(), "superseded");
  const row = h.rows.get(ID)!;
  assert.equal(row.decision, "superseded");
  assert.match(row.outcome!, /without the desk's decision/);
  assert.ok(row.activatedAt, "it did go live");
  const activated = h.events.find((e) => e.kind === "release_activated")!;
  assert.equal(activated.by, "host");
  assert.equal(activated.generation, 2);
});

test("a staged generation that went away below the active one (a rollback, a restart) settles superseded with release_unstaged, not activated", async () => {
  const h = harness();
  h.daemon.generation = 3;
  h.daemon.staged = 4;
  await h.watcher.tick();
  h.daemon.generation = 2;
  h.daemon.staged = null;
  assert.equal(await h.watcher.tick(), "superseded");
  assert.equal(h.rows.get("eu-west-1-ec2-g4-i-store1")!.activatedAt, null);
  assert.deepEqual(h.events.map((e) => e.kind), ["release_staged", "release_unstaged"]);
});

test("a lost socket during the unlock is transient: the row stays approved, the next tick unlocks; a daemon refusal settles the row failed once and is not retried in a loop", async () => {
  let socketDown = true;
  const h = harness({ unlock: async () => { if (socketDown) throw Object.assign(new Error("the daemon closed the socket"), { code: "closed" }); return h.defaultUnlock(); } });
  h.daemon.staged = 2;
  await h.watcher.tick();
  Object.assign(h.rows.get(ID)!, { decision: "approved", decidedBy: "seth@zudocs.com" });
  assert.equal(await h.watcher.tick(), "transient");
  assert.equal(h.rows.get(ID)!.decision, "approved", "the decision stands");
  assert.ok(h.logs.some((l) => l.event === "approval_unlock_transient"));
  socketDown = false;
  assert.equal(await h.watcher.tick(), "activated");
  assert.equal(h.events.filter((e) => e.kind === "approval_failed").length, 0);

  const r = harness({ unlock: async () => { throw new Refusal("release_staged is not the one the operator named"); } });
  r.daemon.staged = 2;
  await r.watcher.tick();
  Object.assign(r.rows.get(ID)!, { decision: "approved", decidedBy: "seth@zudocs.com" });
  assert.equal(await r.watcher.tick(), "failed");
  assert.equal(r.rows.get(ID)!.decision, "failed");
  assert.match(r.rows.get(ID)!.outcome!, /release_staged/);
  assert.equal(await r.watcher.tick(), "waiting", "the failed row is minded, not re-opened");
  assert.equal(await r.watcher.tick(), "waiting");
  assert.equal(r.rows.size, 1);
  assert.equal(r.events.filter((e) => e.kind === "approval_failed").length, 1);
});

test("an unlock that finds nothing staged leaves the row for the next tick, which sees the new state", async () => {
  const h = harness({ unlock: async () => null });
  h.daemon.staged = 2;
  await h.watcher.tick();
  Object.assign(h.rows.get(ID)!, { decision: "approved", decidedBy: "seth@zudocs.com" });
  assert.equal(await h.watcher.tick(), "waiting");
  h.daemon.generation = 2;
  h.daemon.staged = null;
  assert.equal(await h.watcher.tick(), "superseded", "someone else activated it in between; the row says so");
});

test("two ticks at once share one pass; a store that throws is logged and never escapes tick()", async () => {
  const h = harness();
  h.daemon.staged = 2;
  const [a, b] = await Promise.all([h.watcher.tick(), h.watcher.tick()]);
  assert.equal(a, "opened");
  assert.equal(b, "opened", "the same promise");
  assert.equal(h.events.length, 1);
  (h.store as { getApproval: WatcherPorts["store"]["getApproval"] }).getApproval = async () => { throw new Error("throttled"); };
  assert.equal(await h.watcher.tick(), "idle");
  assert.ok(h.logs.some((l) => l.event === "approval_watcher_failed" && String(l.reason).includes("throttled")));
});
