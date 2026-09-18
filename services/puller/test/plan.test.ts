import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullBundleResult } from "@airprompter/agent-sdk";
import { EMPTY_STATE, advance, objectKeyOf, parseTrigger, planPull, pullerHealth, type PullerState, type ReleaseRow } from "../src/plan.js";

const now = "2026-09-18T20:00:00.000Z";
const edge = { pointerUrl: "https://edge/g/x/generation.json", pointerEtag: '"p1"', manifestEtag: '"m1"', lastOriginAt: "2026-09-18T19:50:00.000Z" };
const row = (generation: number, keyId: string | null): ReleaseRow => ({ pk: "release#agent_x/dev", generation, releaseDigest: `sha256:${generation}`, pulledAt: now, keyId, object: objectKeyOf("releases/", generation, keyId), bytes: 10, notAfter: "2026-12-17T20:00:00.000Z", via: "tick" });
const state = (over: Partial<PullerState> = {}): PullerState => ({ ...EMPTY_STATE, edge, ...over });

test("parseTrigger: EventBridge's tick, SQS records as one nudge (by and at from the body, ids collected; a body that is not JSON is still a nudge)", () => {
  assert.deepEqual(parseTrigger({ action: "tick" }), { kind: "tick" });
  assert.deepEqual(parseTrigger(undefined), { kind: "tick" });
  assert.deepEqual(parseTrigger({ Records: [{ messageId: "m1", body: JSON.stringify({ kind: "nudge", by: "seth@zudocs.com", at: "2026-09-18T19:59:00.000Z" }) }] }), { kind: "nudge", by: "seth@zudocs.com", sentAt: "2026-09-18T19:59:00.000Z", messageIds: ["m1"] });
  assert.deepEqual(parseTrigger({ Records: [{ messageId: "m2", body: "not json" }] }), { kind: "nudge", by: "unknown", sentAt: null, messageIds: ["m2"] });
  assert.equal(parseTrigger({ Records: [{ messageId: "m3", body: JSON.stringify({ by: "x".repeat(300), at: "yesterday" }) }] }).kind === "nudge" && (parseTrigger({ Records: [{ messageId: "m3", body: JSON.stringify({ by: "x".repeat(300), at: "yesterday" }) }] }) as { by: string }).by.length, 120, "a long name is cut; a non-ISO instant is dropped");
  assert.deepEqual(parseTrigger({ Records: [] }), { kind: "tick" });
});

test("planPull: a tick pulls pointer-first with the saved edge; inside the backoff window it does nothing; a nudge always pulls and skips the pointer", () => {
  const tick = planPull({ now, trigger: { kind: "tick" }, state: state(), newest: row(3, "k1"), keyId: "k1" });
  assert.deepEqual(tick, { pull: true, reason: "tick", skipPointer: false, edge, nextPullAt: null });
  const later = "2026-09-18T20:04:00.000Z";
  const backed = planPull({ now, trigger: { kind: "tick" }, state: state({ nextPullAt: later }), newest: row(3, "k1"), keyId: "k1" });
  assert.deepEqual(backed, { pull: false, reason: "backoff", skipPointer: false, edge, nextPullAt: later });
  const due = planPull({ now: "2026-09-18T20:04:00.000Z", trigger: { kind: "tick" }, state: state({ nextPullAt: later }), newest: row(3, "k1"), keyId: "k1" });
  assert.equal(due.pull, true, "at the instant it is due");
  const nudge = planPull({ now, trigger: { kind: "nudge", by: "seth", sentAt: null, messageIds: ["m"] }, state: state({ nextPullAt: later }), newest: row(3, "k1"), keyId: "k1" });
  assert.deepEqual(nudge, { pull: true, reason: "nudge", skipPointer: true, edge, nextPullAt: null }, "a nudge beats the backoff and reads the origin");
});

test("planPull: a key the held generation is not sealed to is a re-seal — the origin is read with the manifest ETag dropped, whatever the trigger or the backoff", () => {
  for (const held of [row(3, "old"), row(3, null)]) {
    const plan = planPull({ now, trigger: { kind: "tick" }, state: state({ nextPullAt: "2026-09-18T20:04:00.000Z" }), newest: held, keyId: "new" });
    assert.deepEqual(plan, { pull: true, reason: "reseal", skipPointer: true, edge: { ...edge, manifestEtag: null }, nextPullAt: null });
  }
  assert.equal(planPull({ now, trigger: { kind: "tick" }, state: state(), newest: null, keyId: "new" }).reason, "tick", "nothing held: nothing to re-seal");
  assert.equal(planPull({ now, trigger: { kind: "tick" }, state: state(), newest: row(3, "old"), keyId: null }).reason, "tick", "no key in the exchange: the held row stands");
  assert.deepEqual(planPull({ now, trigger: { kind: "tick" }, state: state({ edge: null }), newest: row(3, "old"), keyId: "new" }).edge, null, "no saved edge stays none");
});

test("advance: the SDK's backoff stretches on unchanged and snaps back on ok/refused/unavailable; the edge is taken from the result; reads are counted per hour", () => {
  const interval = 60_000;
  const unchanged = (via: "pointer" | "origin"): PullBundleResult => ({ status: "unchanged", via, edge: { ...edge, pointerEtag: '"p2"' } });
  let s = advance(state(), unchanged("pointer"), { now, intervalMs: interval, trigger: "tick" });
  assert.equal(s.unchangedStreak, 1);
  assert.equal(s.nextPullAt, "2026-09-18T20:01:45.000Z", "one unchanged: the interval doubled, less the schedule's tolerance");
  assert.deepEqual(s.reads, { hour: "2026-09-18T20", pointer: 1, origin: 0 });
  assert.equal(s.edge?.pointerEtag, '"p2"');
  s = advance(s, unchanged("pointer"), { now, intervalMs: interval, trigger: "tick" });
  s = advance(s, unchanged("pointer"), { now, intervalMs: interval, trigger: "tick" });
  s = advance(s, unchanged("pointer"), { now, intervalMs: interval, trigger: "tick" });
  assert.equal(s.unchangedStreak, 4);
  assert.equal(s.nextPullAt, "2026-09-18T20:04:45.000Z", "capped at five minutes");
  assert.equal(s.reads.pointer, 4);
  s = advance(s, unchanged("origin"), { now, intervalMs: interval, trigger: "tick" });
  assert.deepEqual(s.reads, { hour: "2026-09-18T20", pointer: 4, origin: 1 }, "an origin 304 is an API read");
  const ok: PullBundleResult = { status: "ok", bundle: {} as never, manifest: {} as never, generation: 4, releaseDigest: "sha256:4", createdAt: now, notAfter: "2026-12-17T20:00:00.000Z", trustedRoot: {} as never, edge: { ...edge, manifestEtag: '"m2"' } };
  s = advance(s, ok, { now, intervalMs: interval, trigger: "nudge" });
  assert.equal(s.unchangedStreak, 0);
  assert.equal(s.nextPullAt, null, "a change: the next tick pulls, no floor");
  assert.equal(s.edge?.manifestEtag, '"m2"');
  assert.deepEqual(s.lastPull, { at: now, outcome: "ok", via: null, reason: null, detail: null, generation: 4, trigger: "nudge" });
  const refused: PullBundleResult = { status: "refused", reason: "generation_rollback", held: 4, detail: "the control plane answered generation 3; the caller holds 4", edge };
  s = advance(s, refused, { now, intervalMs: interval, trigger: "tick" });
  assert.equal(s.lastPull?.reason, "generation_rollback");
  assert.equal(s.nextPullAt, null, "a refusal: the next tick pulls");
  assert.equal(s.lastPull?.detail, "the control plane answered generation 3; the caller holds 4");
  assert.deepEqual(s.edge, edge, "a refusal hands the given edge back unchanged");
  const nextHour = advance(s, unchanged("pointer"), { now: "2026-09-18T21:00:01.000Z", intervalMs: interval, trigger: "tick" });
  assert.deepEqual(nextHour.reads, { hour: "2026-09-18T21", pointer: 1, origin: 0 }, "a new hour starts the counters over");
});

test("objectKeyOf and pullerHealth", () => {
  assert.equal(objectKeyOf("releases/", 3, "abcdefghijklmnop"), "releases/3-abcdefgh.apbundle");
  assert.equal(objectKeyOf("releases/", 3, null), "releases/3-plain.apbundle");
  assert.equal(objectKeyOf("releases/", 3, "a/b c$d"), "releases/3-abcd.apbundle", "only safe characters");
  assert.deepEqual(pullerHealth({ keyReadable: true, lastPull: { at: now, outcome: "unchanged", via: "pointer", reason: null, detail: null, generation: null, trigger: "tick" }, newest: row(3, "k") }), { ok: true, status: "ok", reasons: [] });
  assert.deepEqual(pullerHealth({ keyReadable: false, lastPull: null, newest: null }), { ok: false, status: "failing", reasons: ["agent_key_unreadable", "nothing_pulled_yet"] });
  assert.equal(pullerHealth({ keyReadable: true, lastPull: { at: now, outcome: "refused", via: null, reason: "generation_rollback", detail: null, generation: null, trigger: "tick" }, newest: row(3, "k") }).status, "degraded");
  assert.equal(pullerHealth({ keyReadable: true, lastPull: { at: now, outcome: "unavailable", via: null, reason: "network", detail: null, generation: null, trigger: "tick" }, newest: row(3, "k") }).status, "failing");
});
