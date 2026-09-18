import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullBundleInput, PullBundleResult } from "@airprompter/agent-sdk";
import { distributionKeyId, generateX25519KeyPair } from "@airprompter/agent-sdk";
import { buildStatusDoc } from "../../airgap/src/status.js";
import type { PullerEnv } from "../src/env.js";
import { readPullerEnv } from "../src/env.js";
import type { Exchange, PublicKeyRead } from "../src/exchange.js";
import { pass, type PullerDeps } from "../src/handler.js";
import { EMPTY_STATE, type PullerState, type ReleaseRow } from "../src/plan.js";
import type { DeskTables, ReleasesTable } from "../src/tables.js";

const ENV: NodeJS.ProcessEnv = {
  EXCHANGE_BUCKET: "zudocs-exchange-1", RELEASES_TABLE: "zudocs-agent-releases", STATUS_TABLE: "zudocs-desk-status", EVENTS_TABLE: "zudocs-desk-events", TABLES_REGION: "us-east-1", AWS_REGION: "ap-southeast-1",
  AGENT_KEY_PARAMETER: "/zudocs/dev/agent-key", AIRPROMPTER_BASE_URL: "https://api-dev.example", AIRPROMPTER_ORGANIZATION_ID: "org-1", AIRPROMPTER_AGENT_ID: "agent_x", AIRPROMPTER_ENVIRONMENT: "dev", AIRPROMPTER_HOSTED_ENVIRONMENT: "dev",
  AIRPROMPTER_ROOT_URL: "https://edge.example/roots/dev/root.json", AIRPROMPTER_EDGE_POINTER_URL: "https://edge.example/g/tok/generation.json", AIRPROMPTER_ROOT_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y" }), PULL_INTERVAL_SECONDS: "60",
};

test("readPullerEnv: every name, the parameter is a name, a key in the environment is refused, the interval has a floor", () => {
  const env = readPullerEnv(ENV);
  assert.equal(env.agentKeyParameter, "/zudocs/dev/agent-key");
  assert.equal(env.pullIntervalSeconds, 60);
  assert.equal(env.airprompter.edgePointerUrl, "https://edge.example/g/tok/generation.json");
  assert.throws(() => readPullerEnv({ ...ENV, EXCHANGE_BUCKET: "" }), /EXCHANGE_BUCKET is missing/);
  assert.throws(() => readPullerEnv({ ...ENV, AIRPROMPTER_AGENT_KEY: "apa_x" }), /never from a variable/);
  assert.throws(() => readPullerEnv({ ...ENV, AGENT_KEY_PARAMETER: "apa_x" }), /never a key/);
  assert.throws(() => readPullerEnv({ ...ENV, PULL_INTERVAL_SECONDS: "5" }), /at least 30/);
  assert.throws(() => readPullerEnv({ ...ENV, AIRPROMPTER_ENVIRONMENT: "qa" }), /dev, staging or prod/);
});

interface World {
  deps: PullerDeps;
  rows: ReleaseRow[];
  state: PullerState;
  objects: Map<string, string>;
  status: Map<string, Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  pulls: Array<Pick<PullBundleInput, "skipPointer" | "edge" | "minimumGeneration" | "distributionPublicKey">>;
  publicKey: PublicKeyRead;
  statusDoc: string | null;
  keyReadable: boolean;
  nextResults: PullBundleResult[];
}

function world(over: Partial<World> = {}): World {
  const w: World = { rows: [], state: { ...EMPTY_STATE }, objects: new Map(), status: new Map(), events: [], pulls: [], publicKey: { key: null, reason: "absent" }, statusDoc: null, keyReadable: true, nextResults: [], deps: null as never, ...over };
  const env: PullerEnv = readPullerEnv(ENV);
  const releases: ReleasesTable = {
    scope: "agent_x/dev",
    readState: async () => ({ ...w.state }),
    writeState: async (state) => { w.state = state; },
    newest: async () => [...w.rows].sort((a, b) => b.generation - a.generation)[0] ?? null,
    writeRelease: async (row, state) => {
      const existing = w.rows.find((r) => r.generation === row.generation);
      if (existing && existing.releaseDigest !== row.releaseDigest) return { written: false };
      w.rows = [...w.rows.filter((r) => r.generation !== row.generation), { pk: "release#agent_x/dev", ...row }];
      w.state = state;
      return { written: true };
    },
  };
  const exchange: Exchange = {
    readPublicKey: async () => w.publicKey,
    readStatusDoc: async () => (w.statusDoc ? (JSON.parse(w.statusDoc) as never) : null),
    writeBundle: async (key, text) => { w.objects.set(key, text); },
    writeLatest: async (pointer) => { w.objects.set("latest.json", JSON.stringify(pointer)); },
  };
  const desk: DeskTables = {
    updateStatus: async (hostId, fields) => { w.status.set(hostId, { ...(w.status.get(hostId) ?? {}), ...fields }); },
    appendEvent: async (event) => { w.events.push(event); },
  };
  w.deps = {
    env,
    releases,
    exchange,
    desk,
    agentKey: async () => { if (!w.keyReadable) throw Object.assign(new Error("ParameterNotFound"), { name: "ParameterNotFound" }); return "apa_test"; },
    fetch: (async () => { throw new Error("no network in a test"); }) as never,
    now: () => "2026-09-18T20:00:00.000Z",
    pull: async (input) => {
      w.pulls.push({ skipPointer: input.skipPointer, edge: input.edge, minimumGeneration: input.minimumGeneration, distributionPublicKey: input.distributionPublicKey });
      const next = w.nextResults.shift();
      if (!next) throw new Error("the test queued no pull result");
      return next;
    },
  };
  return w;
}

const okResult = (generation: number, edge: NonNullable<PullBundleInput["edge"]>): PullBundleResult => ({ status: "ok", bundle: { v: 1, kind: "airprompter-bundle" } as never, manifest: {} as never, generation, releaseDigest: `sha256:${generation}`, createdAt: "2026-09-18T20:00:00.000Z", notAfter: "2026-12-17T20:00:00.000Z", trustedRoot: {} as never, edge });
const edge1 = { pointerUrl: "https://edge.example/g/tok/generation.json", pointerEtag: '"p1"', manifestEtag: '"m1"', lastOriginAt: "2026-09-18T20:00:00.000Z" };

test("a first tick with no key in the exchange pulls plaintext (dev), writes the object, the row, the pointer, the event and its status row; the pointer URL from the environment seeds the edge", async () => {
  const w = world({ nextResults: [okResult(3, edge1)] });
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "tick", outcome: "ok", generation: 3 });
  assert.deepEqual(w.pulls[0], { skipPointer: false, edge: { pointerUrl: "https://edge.example/g/tok/generation.json", pointerEtag: null, manifestEtag: null, lastOriginAt: null }, minimumGeneration: 0, distributionPublicKey: null });
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0]!.object, "releases/3-plain.apbundle");
  assert.equal(w.rows[0]!.keyId, null);
  assert.ok(w.objects.has("releases/3-plain.apbundle") && w.objects.has("latest.json"));
  assert.equal(JSON.parse(w.objects.get("latest.json")!).generation, 3);
  assert.deepEqual(w.events.map((e) => e.kind), ["bundle_pulled"]);
  assert.equal(w.events[0]!.sealed, false);
  assert.equal(w.state.edge?.manifestEtag, '"m1"', "the edge was saved with the row");
  const row = w.status.get("ap-southeast-1/puller")!;
  assert.equal(row.kind, "puller");
  assert.deepEqual(row.healthz, { ok: true, status: "ok", reasons: [] });
  assert.equal((row.status as { generation: number }).generation, 3);
});

test("the next tick is unchanged via the pointer: no row, no object, no event, the streak and the backoff advance; a tick inside the backoff window pulls nothing", async () => {
  const w = world({ nextResults: [okResult(3, edge1), { status: "unchanged", via: "pointer", edge: edge1 }] });
  await pass(w.deps, { action: "tick" });
  assert.equal(w.state.nextPullAt, null, "after a change the next tick pulls");
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "tick", outcome: "unchanged", generation: null });
  assert.deepEqual(w.pulls[1]!.edge, edge1, "the saved edge went back verbatim");
  assert.equal(w.pulls[1]!.minimumGeneration, 3);
  assert.equal(w.events.length, 1);
  assert.equal(w.state.unchangedStreak, 1);
  assert.equal(w.state.nextPullAt, "2026-09-18T20:01:45.000Z");
  const skipped = await pass(w.deps, { action: "tick" });
  assert.deepEqual(skipped, { plan: "backoff", outcome: null, generation: null });
  assert.equal(w.pulls.length, 2, "no pull inside the window");
});

test("a nudge pulls with skipPointer whatever the backoff, counts itself, and is a timeline row", async () => {
  const w = world({ nextResults: [okResult(3, edge1), { status: "unchanged", via: "pointer", edge: edge1 }, { status: "unchanged", via: "origin", edge: edge1 }] });
  await pass(w.deps, { action: "tick" });
  await pass(w.deps, { action: "tick" });
  const out = await pass(w.deps, { Records: [{ messageId: "m1", body: JSON.stringify({ by: "seth@zudocs.com", at: "2026-09-18T19:59:59.000Z" }) }] });
  assert.deepEqual(out, { plan: "nudge", outcome: "unchanged", generation: null });
  assert.equal(w.pulls[2]!.skipPointer, true);
  assert.deepEqual(w.events.map((e) => e.kind), ["bundle_pulled", "nudged"]);
  assert.equal(w.events[1]!.by, "seth@zudocs.com");
  assert.equal(w.state.nudges, 1);
  assert.equal(w.state.lastPull?.trigger, "nudge");
});

test("a key published after a plaintext pull re-seals the held generation: the origin is read with the manifest ETag dropped, the row's key and object change, the event says reseal", async () => {
  const pair = generateX25519KeyPair();
  const keyId = distributionKeyId(pair.publicRaw);
  const w = world({ nextResults: [okResult(3, edge1), okResult(3, { ...edge1, manifestEtag: '"m1b"' }), { status: "unchanged", via: "pointer", edge: edge1 }] });
  await pass(w.deps, { action: "tick" });
  w.publicKey = { key: { keyId, raw: pair.publicRaw }, reason: null };
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "reseal", outcome: "ok", generation: 3 });
  assert.deepEqual(w.pulls[1], { skipPointer: true, edge: { ...edge1, manifestEtag: null }, minimumGeneration: 3, distributionPublicKey: pair.publicRaw });
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0]!.keyId, keyId);
  assert.equal(w.rows[0]!.object, `releases/3-${keyId.slice(0, 8)}.apbundle`);
  assert.equal(w.rows[0]!.via, "reseal");
  assert.equal(w.events[1]!.trigger, "reseal");
  assert.equal(w.events[1]!.sealed, true);
  assert.equal(JSON.parse(w.objects.get("latest.json")!).keyId, keyId);
  const third = await pass(w.deps, { action: "tick" });
  assert.equal(third.plan, "tick", "sealed to the right key: no re-seal again");
});

test("the same generation with another digest is kept as it was and reported; a refusal and an outage are timeline rows and the health says so", async () => {
  const conflicting: PullBundleResult = { ...(okResult(3, edge1) as Extract<PullBundleResult, { status: "ok" }>), releaseDigest: "sha256:other" };
  const w = world({ nextResults: [okResult(3, edge1), conflicting, { status: "refused", reason: "generation_rollback", held: 3, detail: "answered 2", edge: edge1 }, { status: "unavailable", reason: "network", detail: "ECONNRESET", edge: edge1 }] });
  await pass(w.deps, { action: "tick" });
  await pass(w.deps, { Records: [{ messageId: "n", body: "{}" }] });
  assert.equal(w.rows[0]!.releaseDigest, "sha256:3", "the row stands");
  assert.deepEqual(w.events.map((e) => e.kind), ["bundle_pulled", "nudged", "pull_conflict"]);
  await pass(w.deps, { Records: [{ messageId: "n2", body: "{}" }] });
  assert.equal(w.events.at(-1)!.kind, "pull_failed");
  assert.equal(w.events.at(-1)!.reason, "generation_rollback");
  assert.equal((w.status.get("ap-southeast-1/puller")!.healthz as { status: string }).status, "degraded");
  await pass(w.deps, { Records: [{ messageId: "n3", body: "{}" }] });
  assert.equal((w.status.get("ap-southeast-1/puller")!.healthz as { status: string }).status, "failing");
});

test("an unreadable Agent key: a tick pulls nothing and writes a failing row naming the parameter; a nudge throws so the queue retries it", async () => {
  const w = world({ keyReadable: false });
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "tick", outcome: null, generation: null });
  assert.equal(w.pulls.length, 0);
  const row = w.status.get("ap-southeast-1/puller")!;
  assert.deepEqual((row.healthz as { reasons: string[] }).reasons, ["agent_key_unreadable", "nothing_pulled_yet"]);
  assert.equal((row.status as { agentKeyParameter: string }).agentKeyParameter, "/zudocs/dev/agent-key");
  await assert.rejects(() => pass(w.deps, { Records: [{ messageId: "m", body: "{}" }] }), /not honoured/);
});

test("the air-gapped host's document is mirrored into its own row and the timeline when it changed, and not again for the same document", async () => {
  const doc = buildStatusDoc({ hostId: "ap-southeast-1/airgap", region: "ap-southeast-1", sdk: "agent-sdk-ts/0.2.14", startedAt: "2026-09-18T19:50:00.000Z", now: "2026-09-18T19:59:00.000Z", seq: 3, ec2: { instanceId: "i-1", availabilityZone: "ap-southeast-1a" }, keyId: "k1", phase: "serving", waitingFor: null, status: { instanceId: "inst", generation: 3, applyState: "active" } as never, healthz: { ok: true, status: "ok", reasons: [] } as never, applies: [{ at: "2026-09-18T19:51:00.000Z", generation: 3, outcome: "activated", reason: null, detail: null, source: "vendored", object: null }], renders: { count: 1, lastAt: null, last: null, observation: "refused" }, export: null, probe: null, log: [] });
  const w = world({ nextResults: [{ status: "unchanged", via: "pointer", edge: edge1 }, { status: "unchanged", via: "pointer", edge: edge1 }], statusDoc: JSON.stringify(doc), state: { ...EMPTY_STATE, edge: edge1, nextPullAt: null } });
  w.rows = [{ pk: "release#agent_x/dev", generation: 3, releaseDigest: "sha256:3", pulledAt: "2026-09-18T19:00:00.000Z", keyId: null, object: "releases/3-plain.apbundle", bytes: 1, notAfter: "2026-12-17T20:00:00.000Z", via: "tick" }];
  await pass(w.deps, { action: "tick" });
  const airgap = w.status.get("ap-southeast-1/airgap")!;
  assert.equal(airgap.kind, "airgapped");
  assert.equal(airgap.writtenAt, "2026-09-18T19:59:00.000Z");
  assert.deepEqual(w.events.filter((e) => e.host === "ap-southeast-1/airgap").map((e) => e.kind), ["airgap_started", "distribution_key_born", "airgap_applied"]);
  assert.equal(w.state.airgap.writtenAt, "2026-09-18T19:59:00.000Z");
  const before = w.events.length;
  w.state = { ...w.state, nextPullAt: null };
  await pass(w.deps, { action: "tick" });
  assert.equal(w.events.length, before, "the same document is not mirrored twice");
});
