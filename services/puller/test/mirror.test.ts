import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStatusDoc, parseStatusDoc, type AirgapStatusDoc } from "../../airgap/src/status.js";
import { EMPTY_STATE } from "../src/plan.js";
import { mirrorAirgap } from "../src/mirror.js";
import { parsePublicKeyFile } from "../src/exchange.js";
import { distributionKeyId, generateX25519KeyPair } from "@airprompter/agent-sdk";

const now = "2026-09-18T20:10:00.000Z";
const doc = (over: Partial<Parameters<typeof buildStatusDoc>[0]> = {}): AirgapStatusDoc =>
  buildStatusDoc({
    hostId: "ap-southeast-1/airgap",
    region: "ap-southeast-1",
    sdk: "agent-sdk-ts/0.2.14",
    startedAt: "2026-09-18T20:00:00.000Z",
    now: "2026-09-18T20:09:30.000Z",
    seq: 9,
    ec2: { instanceId: "i-abc", availabilityZone: "ap-southeast-1a" },
    keyId: "k1",
    phase: "serving",
    waitingFor: null,
    status: { instanceId: "inst-1", generation: 3, stagedGeneration: null, applyState: "active", leaseExpiresAt: null } as never,
    healthz: { ok: true, status: "ok", reasons: [] } as never,
    applies: [{ at: "2026-09-18T20:01:00.000Z", generation: 3, outcome: "activated", reason: null, detail: null, source: "vendored", object: null }],
    renders: { count: 4, lastAt: "2026-09-18T20:09:00.000Z", last: { tag: "support.triage", versionId: "rev-2", arm: "none", model: "amazon.nova-micro", subject: "cust-1001" }, observation: "refused" },
    export: { at: "2026-09-18T20:06:00.000Z", segments: 1, bytes: 400, instances: 1, object: "telemetry/i-abc/x.aptelemetry", generation: 3 },
    probe: { at: "2026-09-18T20:00:10.000Z", curl: { url: "https://api-dev.airprompter.com/", exit: 28, seconds: 8, meaning: "connect timed out — no route out" }, dns: { name: "api-dev.airprompter.com", resolved: true, detail: "resolved by the VPC resolver (a name is not a route)" } },
    log: [],
    ...over,
  });

test("the first mirror of a fresh host: started, key born, every apply, the export; the row carries the host's own instant and the puller's; nothing about health yet", () => {
  const { fields, events, next } = mirrorAirgap({ doc: doc(), previous: EMPTY_STATE.airgap, now, keyIdInExchange: "k1" });
  assert.deepEqual(events.map((e) => e.kind), ["airgap_started", "distribution_key_born", "airgap_applied", "telemetry_exported"]);
  assert.equal(events[1]!.published, true);
  assert.equal(events[2]!.generation, 3);
  assert.equal(fields.kind, "airgapped");
  assert.equal(fields.writtenAt, "2026-09-18T20:09:30.000Z", "the host's instant, so a torn-down host fades");
  assert.equal(fields.mirroredAt, now);
  assert.deepEqual((fields.container as { invocations: number }).invocations, 4, "renders stand in for invocations");
  assert.deepEqual((fields.airgap as { keyPublished: boolean }).keyPublished, true);
  assert.deepEqual(next, { writtenAt: "2026-09-18T20:09:30.000Z", startedAt: "2026-09-18T20:00:00.000Z", lastAppliedAt: "2026-09-18T20:01:00.000Z", lastExportAt: "2026-09-18T20:06:00.000Z", health: "ok:", keyId: "k1" });
});

test("the second mirror: only what is new — a newer apply, a newer export, a health change; a repeated document adds nothing", () => {
  const first = mirrorAirgap({ doc: doc(), previous: EMPTY_STATE.airgap, now, keyIdInExchange: "k1" });
  const again = mirrorAirgap({ doc: doc(), previous: first.next, now, keyIdInExchange: "k1" });
  assert.deepEqual(again.events, [], "the same document twice: no row twice");
  const moved = doc({
    now: "2026-09-18T20:15:00.000Z",
    applies: [
      { at: "2026-09-18T20:01:00.000Z", generation: 3, outcome: "activated", reason: null, detail: null, source: "vendored", object: null },
      { at: "2026-09-18T20:14:00.000Z", generation: 4, outcome: "activated", reason: null, detail: null, source: "exchange", object: "releases/4-k1.apbundle" },
    ],
    export: { at: "2026-09-18T20:11:00.000Z", segments: 2, bytes: 800, instances: 1, object: "telemetry/i-abc/y.aptelemetry", generation: 4 },
    healthz: { ok: false, status: "degraded", reasons: ["lease_expired"] } as never,
  });
  const second = mirrorAirgap({ doc: moved, previous: first.next, now: "2026-09-18T20:16:00.000Z", keyIdInExchange: "k1" });
  assert.deepEqual(second.events.map((e) => e.kind), ["airgap_applied", "telemetry_exported", "health_changed"]);
  assert.equal(second.events[0]!.generation, 4);
  assert.equal(second.events[1]!.segments, 2);
  assert.equal(second.events[2]!.status, "degraded");
  assert.equal(second.next.lastAppliedAt, "2026-09-18T20:14:00.000Z");
  assert.equal(second.next.health, "degraded:lease_expired");
});

test("a host that restarted is a new startedAt; a document with no SDK yet reports its phase as the health; a key not yet in the exchange is unpublished", () => {
  const first = mirrorAirgap({ doc: doc(), previous: EMPTY_STATE.airgap, now, keyIdInExchange: "k1" });
  const restarted = doc({ startedAt: "2026-09-18T21:00:00.000Z", now: "2026-09-18T21:00:30.000Z", status: null, healthz: null, phase: "awaiting_bundle", waitingFor: { newest: { generation: 4, keyId: "old" } }, applies: [], export: null });
  const m = mirrorAirgap({ doc: restarted, previous: first.next, now: "2026-09-18T21:01:00.000Z", keyIdInExchange: "old" });
  assert.deepEqual(m.events.map((e) => e.kind), ["airgap_started", "health_changed"]);
  assert.deepEqual(m.fields.healthz, { ok: false, status: "degraded", reasons: ["awaiting_bundle"] });
  assert.equal((m.fields.airgap as { keyPublished: boolean }).keyPublished, false);
  assert.equal(m.next.lastAppliedAt, "2026-09-18T20:01:00.000Z", "an empty applies list forgets nothing");
});

test("parseStatusDoc refuses what is not a status document; parsePublicKeyFile checks the kind, the length and the id", () => {
  assert.equal(parseStatusDoc("not json"), null);
  assert.equal(parseStatusDoc(JSON.stringify({ kind: "something-else", v: 1 })), null);
  assert.equal(parseStatusDoc(JSON.stringify(doc()))?.hostId, "ap-southeast-1/airgap");
  const pair = generateX25519KeyPair();
  const publicKey = Buffer.from(pair.publicRaw).toString("base64url");
  const keyId = distributionKeyId(pair.publicRaw);
  assert.equal(parsePublicKeyFile({ kind: "airprompter-distribution-public-key", v: 1, keyId, publicKey, createdAt: now }).keyId, keyId);
  assert.throws(() => parsePublicKeyFile({ kind: "airprompter-distribution-key", publicKey, privateKey: "x" }), /kind airprompter-distribution-public-key/, "a private key file is refused even for its public half");
  assert.throws(() => parsePublicKeyFile({ kind: "airprompter-distribution-public-key", keyId: "wrong", publicKey }), /keyId does not match/);
  assert.throws(() => parsePublicKeyFile({ kind: "airprompter-distribution-public-key", publicKey: "short" }), /32-byte/);
});
