/**
 * The puller's schedule: when a tick or a nudge pulls, and how a result stretches the next one.
 *
 * @example
 * ```sh
 * npm test --workspace services/puller
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullToDatastoreResult } from "@airprompter/agent-sdk";
import { EMPTY_STATE, NUDGE_IDS_KEPT, advance, countNudge, parseTrigger, planPull, pullerHealth, type PullerState } from "../src/plan.js";

const now = "2026-09-18T20:00:00.000Z";
const state = (over: Partial<PullerState> = {}): PullerState => ({ ...EMPTY_STATE, ...over });
const key = (keyId: string | null, malformed: string | null = null) => ({ keyId, malformed });
const tick = { kind: "tick" } as const;
const edge = { pointerUrl: "https://edge/g/x/generation.json", pointerEtag: '"p1"', manifestEtag: '"m1"', lastOriginAt: now };
const keyOf = { organizationId: "org-1", agentId: "agent_x", target: "dev" as const, region: "ap-southeast-1" };

const ok = (generation: number): PullToDatastoreResult => ({ status: "ok", bundle: {} as never, manifest: {} as never, generation, releaseDigest: `sha256:${generation}`, createdAt: now, notAfter: "2026-12-17T20:00:00.000Z", trustedRoot: {} as never, edge, key: keyOf, stored: true });

test("parseTrigger: EventBridge's tick, SQS records as one nudge (by and at from the body, ids collected; a body that is not JSON is still a nudge)", () => {
  assert.deepEqual(parseTrigger({ action: "tick" }), { kind: "tick" });
  assert.deepEqual(parseTrigger(undefined), { kind: "tick" });
  assert.deepEqual(parseTrigger({ Records: [{ messageId: "m1", body: JSON.stringify({ kind: "nudge", by: "seth@zudocs.com", at: "2026-09-18T19:59:00.000Z" }) }] }), { kind: "nudge", by: "seth@zudocs.com", sentAt: "2026-09-18T19:59:00.000Z", messageIds: ["m1"] });
  assert.deepEqual(parseTrigger({ Records: [{ messageId: "m2", body: "not json" }] }), { kind: "nudge", by: "unknown", sentAt: null, messageIds: ["m2"] });
  const long = parseTrigger({ Records: [{ messageId: "m3", body: JSON.stringify({ by: "x".repeat(300), at: "yesterday" }) }] });
  assert.equal(long.kind === "nudge" ? long.by.length : 0, 120, "a long name is cut");
  assert.equal(long.kind === "nudge" ? long.sentAt : "x", null, "a non-ISO instant is dropped");
  assert.deepEqual(parseTrigger({ Records: [] }), { kind: "tick" });
});

test("planPull: a tick pulls; with ticks to skip it does nothing; a nudge always pulls and skips the pointer; a malformed key stops everything", () => {
  assert.deepEqual(planPull({ now, trigger: tick, state: state(), key: key("k1") }), { pull: true, reason: "tick", skipPointer: false, nextPullAt: null });
  const later = "2026-09-18T20:04:00.000Z";
  assert.deepEqual(planPull({ now, trigger: tick, state: state({ skipTicks: 2, nextPullAt: later }), key: key("k1") }), { pull: false, reason: "backoff", skipPointer: false, nextPullAt: later });
  const nudge = planPull({ now, trigger: { kind: "nudge", by: "seth", sentAt: null, messageIds: ["m"] }, state: state({ skipTicks: 2, nextPullAt: later }), key: key("k1") });
  assert.deepEqual(nudge, { pull: true, reason: "nudge", skipPointer: true, nextPullAt: null });
  const stopped = planPull({ now, trigger: { kind: "nudge", by: "seth", sentAt: null, messageIds: ["m"] }, state: state(), key: key(null, "publicKey is not a 32-byte X25519 key") });
  assert.equal(stopped.pull, false);
  assert.equal(stopped.reason, "key_malformed");
});

test("countNudge: an id counts once; the list is capped", () => {
  const first = countNudge(state(), ["m1"]);
  assert.equal(first?.nudges, 1);
  assert.equal(countNudge(first!, ["m1"]), null);
  const many = countNudge(state(), Array.from({ length: NUDGE_IDS_KEPT + 5 }, (_, i) => `m${i}`));
  assert.equal(many?.nudgeIds.length, NUDGE_IDS_KEPT);
});

test("advance: an ok snaps the backoff; unchanged stretches it; a datastore outage is a failure and not an origin read", () => {
  const pulled = advance(state(), ok(3), { now, intervalMs: 60_000, trigger: "tick" });
  assert.equal(pulled.skipTicks, 0);
  assert.equal(pulled.lastPull?.generation, 3);
  assert.equal(pulled.reads.origin, 1);
  const idle = advance(pulled, { status: "unchanged", via: "pointer", edge, key: keyOf, stored: false }, { now, intervalMs: 60_000, trigger: "tick" });
  assert.equal(idle.unchangedStreak, 1);
  assert.equal(idle.reads.pointer, 1);
  assert.ok(idle.skipTicks >= 1);
  const down = advance(state(), { status: "datastore_unavailable", key: keyOf, stage: "read", detail: "timeout", stored: false }, { now, intervalMs: 60_000, trigger: "tick" });
  assert.equal(down.failureStreak, 1);
  assert.equal(down.reads.origin, 0);
  assert.equal(down.lastPull?.reason, "read");
});

test("pullerHealth: no release yet is degraded; an unreadable Agent key or a datastore outage is failing", () => {
  assert.equal(pullerHealth({ keyReadable: true, lastPull: null, newestGeneration: null, key: key(null) }).status, "degraded");
  assert.equal(pullerHealth({ keyReadable: false, lastPull: null, newestGeneration: 3, key: key("k1") }).status, "failing");
  const outage = pullerHealth({ keyReadable: true, lastPull: { at: now, outcome: "datastore_unavailable", via: null, reason: "write", detail: null, generation: null, trigger: "tick" }, newestGeneration: 3, key: key("k1") });
  assert.equal(outage.status, "failing");
  assert.equal(pullerHealth({ keyReadable: true, lastPull: { at: now, outcome: "ok", via: null, reason: null, detail: null, generation: 3, trigger: "tick" }, newestGeneration: 3, key: key("k1") }).status, "ok");
});
