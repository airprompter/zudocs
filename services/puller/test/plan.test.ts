import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullBundleResult } from "@airprompter/agent-sdk";
import { EMPTY_STATE, RESEAL_MAX_FAILURES, advance, objectKeyOf, parseTrigger, planPull, pullerHealth, resealNeeded, type PullerState, type ReleaseRow } from "../src/plan.js";

const now = "2026-09-18T20:00:00.000Z";
const edge = { pointerUrl: "https://edge/g/x/generation.json", pointerEtag: '"p1"', manifestEtag: '"m1"', lastOriginAt: "2026-09-18T19:50:00.000Z" };
const row = (generation: number, keyId: string | null): ReleaseRow => ({ pk: "release#agent_x/dev", generation, releaseDigest: `sha256:${generation}`, pulledAt: now, keyId, object: objectKeyOf("releases/", generation, `sha256:${generation}`, keyId), bytes: 10, notAfter: "2026-12-17T20:00:00.000Z", via: "tick" });
const state = (over: Partial<PullerState> = {}): PullerState => ({ ...EMPTY_STATE, edge, ...over });
const key = (keyId: string | null, malformed: string | null = null) => ({ keyId, malformed });
const tick = { kind: "tick" } as const;

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

test("planPull: a tick pulls pointer-first with the saved edge; with ticks to skip it does nothing; a nudge always pulls and skips the pointer; a malformed key stops everything", () => {
  assert.deepEqual(planPull({ now, trigger: tick, state: state(), newest: row(3, "k1"), key: key("k1") }), { pull: true, reason: "tick", skipPointer: false, edge, nextPullAt: null });
  const later = "2026-09-18T20:04:00.000Z";
  assert.deepEqual(planPull({ now, trigger: tick, state: state({ skipTicks: 2, nextPullAt: later }), newest: row(3, "k1"), key: key("k1") }), { pull: false, reason: "backoff", skipPointer: false, edge, nextPullAt: later });
  const nudge = planPull({ now, trigger: { kind: "nudge", by: "seth", sentAt: null, messageIds: ["m"] }, state: state({ skipTicks: 2, nextPullAt: later }), newest: row(3, "k1"), key: key("k1") });
  assert.deepEqual(nudge, { pull: true, reason: "nudge", skipPointer: true, edge, nextPullAt: null }, "a nudge beats the backoff and reads the origin");
  const stopped = planPull({ now, trigger: { kind: "nudge", by: "seth", sentAt: null, messageIds: ["m"] }, state: state(), newest: row(3, null), key: key(null, "publicKey is not a 32-byte X25519 key") });
  assert.equal(stopped.pull, false);
  assert.equal(stopped.reason, "key_malformed", "a malformed key object is never a quiet downgrade to plaintext, not even on a nudge");
});

test("planPull: a key the held generation is not sealed to is a re-seal — the origin is read with the manifest ETag dropped, whatever the trigger or the backoff — until three failures on that key", () => {
  for (const held of [row(3, "old"), row(3, null)]) {
    const plan = planPull({ now, trigger: tick, state: state({ skipTicks: 3 }), newest: held, key: key("new") });
    assert.deepEqual(plan, { pull: true, reason: "reseal", skipPointer: true, edge: { ...edge, manifestEtag: null }, nextPullAt: null });
  }
  assert.equal(planPull({ now, trigger: tick, state: state(), newest: null, key: key("new") }).reason, "tick", "nothing held: nothing to re-seal");
  assert.equal(planPull({ now, trigger: tick, state: state(), newest: row(3, "old"), key: key(null) }).reason, "tick", "no key in the exchange: the held row stands");
  assert.deepEqual(planPull({ now, trigger: tick, state: state({ edge: null }), newest: row(3, "old"), key: key("new") }).edge, null, "no saved edge stays none");
  const givenUp = state({ reseal: { keyId: "new", failures: RESEAL_MAX_FAILURES } });
  assert.equal(resealNeeded(givenUp, row(3, "old"), "new"), false, "three failures on this key: back to the schedule");
  assert.equal(planPull({ now, trigger: tick, state: givenUp, newest: row(3, "old"), key: key("new") }).reason, "tick");
  assert.equal(resealNeeded(givenUp, row(3, "old"), "newer"), true, "a different key is a fresh start");
});

test("advance: unchanged and failures each stretch the interval in ticks to skip (never at the five-minute schedule; 1, 2, 4, 5 minutes in demo); a change snaps back; reads are counted per hour; a re-seal's failures are counted per key", () => {
  const interval = 60_000;
  const unchanged = (via: "pointer" | "origin"): PullBundleResult => ({ status: "unchanged", via, edge: { ...edge, pointerEtag: '"p2"' } });
  let s = advance(state(), unchanged("pointer"), { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.equal(s.unchangedStreak, 1);
  assert.equal(s.skipTicks, 1, "one unchanged: two minutes, so one tick skipped");
  assert.equal(s.nextPullAt, "2026-09-18T20:01:00.000Z");
  assert.deepEqual(s.reads, { hour: "2026-09-18T20", pointer: 1, origin: 0 });
  assert.equal(s.edge?.pointerEtag, '"p2"');
  s = advance(s, unchanged("pointer"), { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.equal(s.skipTicks, 3, "four minutes");
  s = advance(s, unchanged("pointer"), { now, intervalMs: interval, trigger: "tick", keyId: null });
  s = advance(s, unchanged("pointer"), { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.equal(s.unchangedStreak, 4);
  assert.equal(s.skipTicks, 4, "capped at five minutes: four ticks skipped");
  assert.equal(s.reads.pointer, 4);
  s = advance(s, unchanged("origin"), { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.deepEqual(s.reads, { hour: "2026-09-18T20", pointer: 4, origin: 1 }, "an origin 304 is an API read");
  const five = advance(state(), unchanged("pointer"), { now, intervalMs: 300_000, trigger: "tick", keyId: null });
  assert.equal(five.skipTicks, 0, "at the plan's schedule the cap equals the tick: nothing is ever skipped");
  assert.equal(five.nextPullAt, null);
  const ok: PullBundleResult = { status: "ok", bundle: {} as never, manifest: {} as never, generation: 4, releaseDigest: "sha256:4", createdAt: now, notAfter: "2026-12-17T20:00:00.000Z", trustedRoot: {} as never, edge: { ...edge, manifestEtag: '"m2"' } };
  s = advance(s, ok, { now, intervalMs: interval, trigger: "nudge", keyId: null });
  assert.equal(s.unchangedStreak, 0);
  assert.equal(s.skipTicks, 0, "a change: the next tick pulls");
  assert.equal(s.edge?.manifestEtag, '"m2"');
  assert.deepEqual(s.lastPull, { at: now, outcome: "ok", via: null, reason: null, detail: null, generation: 4, trigger: "nudge" });
  const refused: PullBundleResult = { status: "refused", reason: "generation_rollback", held: 4, detail: "the control plane answered generation 3; the caller holds 4", edge };
  s = advance(s, refused, { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.equal(s.lastPull?.reason, "generation_rollback");
  assert.equal(s.failureStreak, 1);
  assert.equal(s.skipTicks, 1, "a failure backs off like an unchanged tick");
  assert.deepEqual(s.edge, edge, "a refusal hands the given edge back unchanged");
  s = advance(s, { status: "nothing_promoted", edge }, { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.equal(s.failureStreak, 2);
  assert.equal(s.lastPull?.reason, "nothing_promoted");
  assert.equal(s.reads.origin, 4, "nothing promoted is an origin read");
  s = advance(s, { status: "refused", reason: "plaintext_not_allowed", edge }, { now, intervalMs: interval, trigger: "tick", keyId: null });
  assert.equal(s.reads.origin, 4, "a refusal before any network call is not a read");
  const nextHour = advance(s, unchanged("pointer"), { now: "2026-09-18T21:00:01.000Z", intervalMs: interval, trigger: "tick", keyId: null });
  assert.deepEqual(nextHour.reads, { hour: "2026-09-18T21", pointer: 1, origin: 0 }, "a new hour starts the counters over");
  let r = advance(state(), { status: "unavailable", reason: "network", edge }, { now, intervalMs: interval, trigger: "reseal", keyId: "k9" });
  assert.deepEqual(r.reseal, { keyId: "k9", failures: 1 });
  r = advance(r, { status: "unavailable", reason: "network", edge }, { now, intervalMs: interval, trigger: "reseal", keyId: "k9" });
  assert.deepEqual(r.reseal, { keyId: "k9", failures: 2 });
  r = advance(r, ok, { now, intervalMs: interval, trigger: "reseal", keyId: "k9" });
  assert.equal(r.reseal, null, "a re-seal that worked clears the count");
});

test("objectKeyOf and pullerHealth", () => {
  assert.equal(objectKeyOf("releases/", 3, "sha256:0123456789abcdef", "abcdefghijklmnop"), "releases/3-01234567-abcdefgh.apbundle");
  assert.equal(objectKeyOf("releases/", 3, "sha256:0123456789abcdef", null), "releases/3-01234567-plain.apbundle");
  assert.equal(objectKeyOf("releases/", 3, "sha256:0123456789abcdef", "a/b c$d"), "releases/3-01234567-abcd.apbundle", "only safe characters");
  const last = (outcome: string, reason: string | null): PullerState["lastPull"] => ({ at: now, outcome, via: null, reason, detail: null, generation: null, trigger: "tick" });
  assert.deepEqual(pullerHealth({ keyReadable: true, lastPull: { ...last("unchanged", null)!, via: "pointer" }, newest: row(3, "k"), key: key("k"), reseal: null }), { ok: true, status: "ok", reasons: [] });
  assert.deepEqual(pullerHealth({ keyReadable: false, lastPull: null, newest: null, key: key(null), reseal: null }), { ok: false, status: "failing", reasons: ["agent_key_unreadable", "nothing_pulled_yet"] });
  assert.equal(pullerHealth({ keyReadable: true, lastPull: last("refused", "generation_rollback"), newest: row(3, "k"), key: key("k"), reseal: null }).status, "degraded");
  assert.equal(pullerHealth({ keyReadable: true, lastPull: last("unavailable", "network"), newest: row(3, "k"), key: key("k"), reseal: null }).status, "failing");
  assert.deepEqual(pullerHealth({ keyReadable: true, lastPull: last("unchanged", null), newest: row(3, "k"), key: key(null, "not a distribution public key file"), reseal: null }).reasons, ["public_key_malformed:not a distribution public key file"]);
  assert.deepEqual(pullerHealth({ keyReadable: true, lastPull: last("unchanged", null), newest: row(3, "old"), key: key("k9abcdef"), reseal: { keyId: "k9abcdef", failures: 3 } }).reasons, ["reseal_failing:k9abcdef"]);
  assert.deepEqual(pullerHealth({ keyReadable: true, lastPull: last("nothing_promoted", "nothing_promoted"), newest: null, key: key(null), reseal: null }).reasons, ["nothing_promoted", "nothing_pulled_yet"]);
});
