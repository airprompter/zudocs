import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullBundleInput, PullBundleResult } from "@airprompter/agent-sdk";
import { distributionKeyId, generateX25519KeyPair } from "@airprompter/agent-sdk";
import { buildStatusDoc } from "../../airgap/src/status.js";
import type { PullerEnv } from "../src/env.js";
import { readPullerEnv } from "../src/env.js";
import type { Exchange, PublicKeyRead } from "../src/exchange.js";
import { pass, runOnce, type PullerDeps } from "../src/handler.js";
import { EMPTY_STATE, type PullerState, type ReleaseRow } from "../src/plan.js";
import { RaceLost, type DeskTables, type ReleasesTable } from "../src/tables.js";

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
  version: number;
  objects: Map<string, string>;
  status: Map<string, Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  pulls: Array<Pick<PullBundleInput, "skipPointer" | "edge" | "minimumGeneration" | "distributionPublicKey">>;
  publicKey: PublicKeyRead;
  statusDoc: string | null;
  keyReadable: boolean;
  nextResults: PullBundleResult[];
  /** A hook the race test uses: bump the version under the running pass. */
  beforeWrite: (() => void) | null;
  statusDenied: string | null;
}

function world(over: Partial<World> = {}): World {
  const w: World = { rows: [], state: { ...EMPTY_STATE }, version: 0, objects: new Map(), status: new Map(), events: [], pulls: [], publicKey: { key: null, reason: "absent" }, statusDoc: null, keyReadable: true, nextResults: [], beforeWrite: null, statusDenied: null, deps: null as never, ...over };
  const env: PullerEnv = readPullerEnv(ENV);
  const checkVersion = (expected: number) => {
    w.beforeWrite?.();
    if (expected !== w.version) throw new RaceLost(expected);
  };
  const releases: ReleasesTable = {
    scope: "agent_x/dev",
    readState: async () => ({ state: { ...w.state }, version: w.version }),
    writeState: async (state, expected) => { checkVersion(expected); w.state = state; w.version = expected + 1; return w.version; },
    newest: async () => [...w.rows].sort((a, b) => b.generation - a.generation)[0] ?? null,
    writeRelease: async (row, state, expected) => {
      checkVersion(expected);
      const existing = w.rows.find((r) => r.generation === row.generation);
      w.state = state;
      w.version = expected + 1;
      if (existing && existing.releaseDigest !== row.releaseDigest) return { written: false, version: w.version };
      w.rows = [...w.rows.filter((r) => r.generation !== row.generation), { pk: "release#agent_x/dev", ...row }];
      return { written: true, version: w.version };
    },
  };
  const exchange: Exchange = {
    readPublicKey: async () => w.publicKey,
    readStatusDoc: async () => ({ doc: w.statusDoc ? (JSON.parse(w.statusDoc) as never) : null, denied: w.statusDenied }),
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

const okResult = (generation: number, edge: NonNullable<PullBundleInput["edge"]>, digest = `sha256:${generation}`): Extract<PullBundleResult, { status: "ok" }> => ({ status: "ok", bundle: { v: 1, kind: "airprompter-bundle" } as never, manifest: {} as never, generation, releaseDigest: digest, createdAt: "2026-09-18T20:00:00.000Z", notAfter: "2026-12-17T20:00:00.000Z", trustedRoot: {} as never, edge });
const edge1 = { pointerUrl: "https://edge.example/g/tok/generation.json", pointerEtag: '"p1"', manifestEtag: '"m1"', lastOriginAt: "2026-09-18T20:00:00.000Z" };
const unchanged = (via: "pointer" | "origin"): PullBundleResult => ({ status: "unchanged", via, edge: edge1 });

test("a first tick with no key in the exchange pulls plaintext (dev), writes the object, the row, the pointer, the event and its status row; the pointer URL from the environment seeds the edge", async () => {
  const w = world({ nextResults: [okResult(3, edge1)] });
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "tick", outcome: "ok", generation: 3 });
  assert.deepEqual(w.pulls[0], { skipPointer: false, edge: { pointerUrl: "https://edge.example/g/tok/generation.json", pointerEtag: null, manifestEtag: null, lastOriginAt: null }, minimumGeneration: 0, distributionPublicKey: null });
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0]!.object, "releases/3-3-plain.apbundle");
  assert.equal(w.rows[0]!.keyId, null);
  assert.ok(w.objects.has("releases/3-3-plain.apbundle") && w.objects.has("latest.json"));
  assert.equal(JSON.parse(w.objects.get("latest.json")!).generation, 3);
  assert.deepEqual(w.events.map((e) => e.kind), ["bundle_pulled"]);
  assert.equal(w.events[0]!.sealed, false);
  assert.equal(w.state.edge?.manifestEtag, '"m1"', "the edge was saved with the row");
  assert.equal(w.version, 2, "the row and the state in one write, then the pointer's record");
  assert.deepEqual(w.state.latest, { generation: 3, keyId: null, object: "releases/3-3-plain.apbundle" });
  const row = w.status.get("ap-southeast-1/puller")!;
  assert.equal(row.kind, "puller");
  assert.deepEqual(row.healthz, { ok: true, status: "ok", reasons: [] });
  assert.equal((row.status as { generation: number }).generation, 3);
});

test("the next tick is unchanged via the pointer: no row, no object, no event, the streak stretches; the stretched ticks are skipped, then the next tick pulls", async () => {
  const w = world({ nextResults: [okResult(3, edge1), unchanged("pointer"), unchanged("pointer")] });
  await pass(w.deps, { action: "tick" });
  assert.equal(w.state.skipTicks, 0, "after a change the next tick pulls");
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "tick", outcome: "unchanged", generation: null });
  assert.deepEqual(w.pulls[1]!.edge, edge1, "the saved edge went back verbatim");
  assert.equal(w.pulls[1]!.minimumGeneration, 3);
  assert.equal(w.events.length, 1);
  assert.equal(w.state.unchangedStreak, 1);
  assert.equal(w.state.skipTicks, 1);
  const skipped = await pass(w.deps, { action: "tick" });
  assert.deepEqual(skipped, { plan: "backoff", outcome: null, generation: null });
  assert.equal(w.pulls.length, 2, "no pull on the skipped tick");
  assert.equal(w.state.skipTicks, 0);
  const again = await pass(w.deps, { action: "tick" });
  assert.equal(again.outcome, "unchanged");
  assert.equal(w.state.skipTicks, 3, "two unchanged: four minutes");
});

test("a nudge pulls with skipPointer whatever the backoff, counts itself, and is a timeline row", async () => {
  const w = world({ nextResults: [okResult(3, edge1), unchanged("pointer"), unchanged("origin")] });
  await pass(w.deps, { action: "tick" });
  await pass(w.deps, { action: "tick" });
  assert.equal(w.state.skipTicks, 1);
  const out = await pass(w.deps, { Records: [{ messageId: "m1", body: JSON.stringify({ by: "seth@zudocs.com", at: "2026-09-18T19:59:59.000Z" }) }] });
  assert.deepEqual(out, { plan: "nudge", outcome: "unchanged", generation: null });
  assert.equal(w.pulls[2]!.skipPointer, true);
  assert.deepEqual(w.events.map((e) => e.kind), ["bundle_pulled", "nudged"]);
  assert.equal(w.events[1]!.by, "seth@zudocs.com");
  assert.equal(w.state.nudges, 1);
  assert.equal(w.state.lastPull?.trigger, "nudge");
  assert.equal(w.state.skipTicks, 0, "a nudge that found nothing snaps the backoff back");
});

test("a key published after a plaintext pull re-seals the held generation: the origin is read with the manifest ETag dropped, the row's key and object change, the event says reseal; a malformed key stops the puller instead", async () => {
  const pair = generateX25519KeyPair();
  const keyId = distributionKeyId(pair.publicRaw);
  const w = world({ nextResults: [okResult(3, edge1), okResult(3, { ...edge1, manifestEtag: '"m1b"' }), unchanged("pointer")] });
  await pass(w.deps, { action: "tick" });
  w.publicKey = { key: { keyId, raw: pair.publicRaw }, reason: null };
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "reseal", outcome: "ok", generation: 3 });
  assert.deepEqual(w.pulls[1], { skipPointer: true, edge: { ...edge1, manifestEtag: null }, minimumGeneration: 3, distributionPublicKey: pair.publicRaw });
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0]!.keyId, keyId);
  assert.equal(w.rows[0]!.object, `releases/3-3-${keyId.slice(0, 8)}.apbundle`);
  assert.equal(w.rows[0]!.via, "reseal");
  assert.equal(w.events[1]!.trigger, "reseal");
  assert.equal(w.events[1]!.sealed, true);
  assert.equal(JSON.parse(w.objects.get("latest.json")!).keyId, keyId);
  const third = await pass(w.deps, { action: "tick" });
  assert.equal(third.plan, "tick", "sealed to the right key: no re-seal again");
  w.publicKey = { key: null, reason: "publicKey is not a 32-byte X25519 key" };
  const stopped = await pass(w.deps, { action: "tick" });
  assert.deepEqual(stopped, { plan: "key_malformed", outcome: null, generation: null });
  assert.equal(w.pulls.length, 3, "nothing was pulled: a malformed key is not plaintext");
  assert.deepEqual((w.status.get("ap-southeast-1/puller")!.healthz as { reasons: string[] }).reasons, ["public_key_malformed:publicKey is not a 32-byte X25519 key"]);
  w.publicKey = { key: null, reason: "denied:AccessDenied" };
  await pass(w.deps, { action: "tick" });
  assert.deepEqual((w.status.get("ap-southeast-1/puller")!.healthz as { reasons: string[] }).reasons, ["public_key_unreadable:AccessDenied"], "a refused key read has its own name");
});

test("a re-seal that keeps failing is given up after three tries until the key changes; the health says so", async () => {
  const pair = generateX25519KeyPair();
  const keyId = distributionKeyId(pair.publicRaw);
  const w = world({ rows: [{ pk: "release#agent_x/dev", generation: 3, releaseDigest: "sha256:3", pulledAt: "t", keyId: null, object: "releases/3-3-plain.apbundle", bytes: 1, notAfter: "n", via: "tick" }], state: { ...EMPTY_STATE, edge: edge1 }, publicKey: { key: { keyId, raw: pair.publicRaw }, reason: null }, nextResults: [{ status: "unavailable", reason: "network", edge: edge1 }, { status: "unavailable", reason: "network", edge: edge1 }, { status: "unavailable", reason: "network", edge: edge1 }, unchanged("pointer")] });
  for (let i = 0; i < 3; i += 1) assert.equal((await pass(w.deps, { action: "tick" })).plan, "reseal");
  assert.deepEqual(w.state.reseal, { keyId, failures: 3 });
  assert.equal(w.events.filter((e) => e.kind === "pull_failed").length, 1, "one pull_failed row for three identical failures");
  w.state = { ...w.state, skipTicks: 0 };
  const after = await pass(w.deps, { action: "tick" });
  assert.equal(after.plan, "tick", "back to the schedule");
  assert.ok((w.status.get("ap-southeast-1/puller")!.healthz as { reasons: string[] }).reasons.includes(`reseal_failing:${keyId.slice(0, 8)}`));
});

test("the same generation with another digest is kept as it was and reported (its object is its own); a refusal and an outage are timeline rows once per change and the health says so", async () => {
  const w = world({ nextResults: [okResult(3, edge1), okResult(3, edge1, "sha256:other"), { status: "refused", reason: "generation_rollback", held: 3, detail: "answered 2", edge: edge1 }, { status: "unavailable", reason: "network", detail: "ECONNRESET", edge: edge1 }, { status: "unavailable", reason: "network", detail: "ECONNRESET", edge: edge1 }] });
  await pass(w.deps, { action: "tick" });
  await pass(w.deps, { Records: [{ messageId: "n", body: "{}" }] });
  assert.equal(w.rows[0]!.releaseDigest, "sha256:3", "the row stands");
  assert.equal(w.rows[0]!.object, "releases/3-3-plain.apbundle", "and its object is untouched (the other digest wrote its own)");
  assert.ok(w.objects.has("releases/3-other-plain.apbundle"));
  assert.equal(JSON.parse(w.objects.get("latest.json")!).object, "releases/3-3-plain.apbundle", "the pointer follows the row, not the conflicting object");
  assert.deepEqual(w.events.map((e) => e.kind), ["bundle_pulled", "nudged", "pull_conflict"]);
  assert.deepEqual(w.state.conflict, { generation: 3, releaseDigest: "sha256:other", at: "2026-09-18T20:00:00.000Z" });
  assert.deepEqual((w.status.get("ap-southeast-1/puller")!.healthz as { reasons: string[] }).reasons, ["pull_conflict:3"], "said on the card until a newer generation lands");
  await pass(w.deps, { Records: [{ messageId: "n2", body: "{}" }] });
  assert.equal(w.events.at(-1)!.kind, "pull_failed");
  assert.equal(w.events.at(-1)!.reason, "generation_rollback");
  assert.equal((w.status.get("ap-southeast-1/puller")!.healthz as { status: string }).status, "degraded");
  await pass(w.deps, { Records: [{ messageId: "n3", body: "{}" }] });
  assert.equal((w.status.get("ap-southeast-1/puller")!.healthz as { status: string }).status, "failing");
  const before = w.events.length;
  await pass(w.deps, { Records: [{ messageId: "n4", body: "{}" }] });
  assert.equal(w.events.filter((e) => e.kind === "pull_failed").length, 2, "the same outage twice is one row (the nudge rows are separate)");
  assert.equal(w.events.length, before + 1, "only the nudge row was added");
  w.nextResults.push(okResult(4, edge1));
  w.state = { ...w.state, skipTicks: 0 };
  await pass(w.deps, { Records: [{ messageId: "n9", body: "{}" }] });
  assert.equal(w.state.conflict, null, "a newer generation ends the conflict");
});

test("an unreadable Agent key: a tick pulls nothing and writes a failing row naming the parameter; a nudge throws so the queue retries it, and is neither counted nor announced", async () => {
  const w = world({ keyReadable: false });
  const out = await pass(w.deps, { action: "tick" });
  assert.deepEqual(out, { plan: "tick", outcome: null, generation: null });
  assert.equal(w.pulls.length, 0);
  const row = w.status.get("ap-southeast-1/puller")!;
  assert.deepEqual((row.healthz as { reasons: string[] }).reasons, ["agent_key_unreadable", "nothing_pulled_yet"]);
  assert.equal((row.status as { agentKeyParameter: string }).agentKeyParameter, "/zudocs/dev/agent-key");
  await assert.rejects(() => pass(w.deps, { Records: [{ messageId: "m", body: "{}" }] }), /not honoured/);
  assert.equal(w.events.length, 0, "no nudged row for a nudge the queue will retry");
  assert.equal(w.state.nudges, 0);
});

test("two invocations at once: a tick that loses the state's version stops cleanly (no row, no event, no status); a nudge that loses runs once more on the fresh state so its pull is never dropped", async () => {
  const w = world({ nextResults: [okResult(3, edge1)] });
  let fired = false;
  w.beforeWrite = () => {
    // Someone else wrote the state between this pass's read and its write.
    if (!fired) { fired = true; w.version += 1; }
  };
  assert.deepEqual(await runOnce(w.deps, { action: "tick" }), { plan: "race_lost", outcome: null, generation: null });
  assert.equal(w.rows.length, 0, "the transaction was cancelled: no row");
  assert.equal(w.events.length, 0);
  assert.equal(w.status.size, 0, "the winner writes the status row, not the loser");
  const n = world({ nextResults: [okResult(3, edge1), okResult(3, { ...edge1, manifestEtag: '"m1b"' })] });
  let bumped = false;
  n.beforeWrite = () => { if (!bumped) { bumped = true; n.version += 1; } };
  const out = await runOnce(n.deps, { Records: [{ messageId: "m", body: JSON.stringify({ by: "seth@zudocs.com" }) }] });
  assert.deepEqual(out, { plan: "nudge", outcome: "ok", generation: 3 });
  assert.equal(n.rows.length, 1, "the second run wrote the row");
  assert.deepEqual(n.events.map((e) => e.kind), ["nudged", "bundle_pulled"], "the nudge is announced once");
  assert.equal(n.state.nudges, 1, "and counted once");
  assert.equal(n.pulls.length, 1, "the race was lost at the count's write, before the origin was read: one read");
  // The race lost on a LATER write (the pointer's record), after the count was persisted: the retry sees the id and counts nothing.
  const later = world({ nextResults: [okResult(3, edge1), okResult(3, edge1), unchanged("pointer")] });
  let writes = 0;
  later.beforeWrite = () => { writes += 1; if (writes === 3) later.version += 1; };
  await runOnce(later.deps, { Records: [{ messageId: "m9", body: "{}" }] });
  assert.equal(later.state.nudges, 1, "counted once although the first run persisted the count before losing");
  assert.equal(later.events.filter((e) => e.kind === "nudged").length, 1);
  // The queue delivering the same message again (a crash after the announce): seen before, not counted, not announced.
  await runOnce(later.deps, { Records: [{ messageId: "m9", body: "{}" }] });
  assert.equal(later.state.nudges, 1);
  assert.equal(later.events.filter((e) => e.kind === "nudged").length, 1);
  const twice = world({ nextResults: [okResult(3, edge1), okResult(3, edge1)] });
  twice.beforeWrite = () => { twice.version += 1; };
  await assert.rejects(() => runOnce(twice.deps, { Records: [{ messageId: "m", body: "{}" }] }), (error: unknown) => error instanceof RaceLost, "a second loss is an error: the queue retries the message");
});

test("the air-gapped host's document is mirrored into its own row and the timeline when it changed, and not again for the same document", async () => {
  const doc = buildStatusDoc({ hostId: "ap-southeast-1/airgap", region: "ap-southeast-1", sdk: "agent-sdk-ts/0.2.14", startedAt: "2026-09-18T19:50:00.000Z", now: "2026-09-18T19:59:00.000Z", seq: 3, ec2: { instanceId: "i-1", availabilityZone: "ap-southeast-1a" }, keyId: "k1", phase: "serving", waitingFor: null, status: { instanceId: "inst", generation: 3, applyState: "active" } as never, healthz: { ok: true, status: "ok", reasons: [] } as never, applies: [{ at: "2026-09-18T19:51:00.000Z", generation: 3, outcome: "activated", reason: null, detail: null, source: "vendored", object: null }], startFailure: null, renders: { count: 1, lastAt: null, last: null, observation: "refused" }, export: null, probe: null, log: [] });
  const w = world({ nextResults: [unchanged("pointer"), unchanged("pointer")], statusDoc: JSON.stringify(doc), state: { ...EMPTY_STATE, edge: edge1 } });
  w.rows = [{ pk: "release#agent_x/dev", generation: 3, releaseDigest: "sha256:3", pulledAt: "2026-09-18T19:00:00.000Z", keyId: null, object: "releases/3-3-plain.apbundle", bytes: 1, notAfter: "2026-12-17T20:00:00.000Z", via: "tick" }];
  await pass(w.deps, { action: "tick" });
  const airgap = w.status.get("ap-southeast-1/airgap")!;
  assert.equal(airgap.kind, "airgapped");
  assert.equal(airgap.writtenAt, "2026-09-18T19:59:00.000Z");
  assert.deepEqual(w.events.filter((e) => e.host === "ap-southeast-1/airgap").map((e) => e.kind), ["airgap_started", "distribution_key_born", "airgap_applied"]);
  assert.equal(w.state.airgap.writtenAt, "2026-09-18T19:59:00.000Z");
  const before = w.events.length;
  w.state = { ...w.state, skipTicks: 0 };
  await pass(w.deps, { action: "tick" });
  assert.equal(w.events.length, before, "the same document is not mirrored twice");
  w.statusDenied = "AccessDenied";
  w.state = { ...w.state, skipTicks: 0 };
  w.nextResults.push(unchanged("pointer"));
  await pass(w.deps, { action: "tick" });
  assert.deepEqual((w.status.get("ap-southeast-1/puller")!.healthz as { reasons: string[] }).reasons, ["airgap_status_unreadable:AccessDenied"], "a refused status read is said on the card, and the row is still written");
});
