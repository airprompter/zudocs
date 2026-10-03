/**
 * One puller pass over fakes: the SDK datastore, the schedule object, the exchange, the desk tables.
 *
 * @example
 * ```sh
 * npm test --workspace services/puller
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryKvStore, distributionKeyId, generateX25519KeyPair, kvReleaseDatastore, type PullToDatastoreInput, type PullToDatastoreResult, type ReleaseDatastore } from "@airprompter/agent-sdk";
import { buildStatusDoc } from "../../airgap/src/status.js";
import type { PullerEnv } from "../src/env.js";
import { readPullerEnv } from "../src/env.js";
import type { Exchange, PublicKeyRead } from "../src/exchange.js";
import { pass, runOnce, type PullerDeps } from "../src/handler.js";
import { EMPTY_STATE, type PullerState } from "../src/plan.js";
import { RaceLost, type DeskTables, type PullerStateStore } from "../src/tables.js";

const ENV: NodeJS.ProcessEnv = {
  EXCHANGE_BUCKET: "zudocs-exchange-1", STATUS_TABLE: "zudocs-desk-status", EVENTS_TABLE: "zudocs-desk-events", TABLES_REGION: "us-east-1", AWS_REGION: "ap-southeast-1",
  AGENT_KEY_PARAMETER: "/zudocs/dev/agent-key", AIRPROMPTER_BASE_URL: "https://api-dev.example", AIRPROMPTER_ORGANIZATION_ID: "org-1", AIRPROMPTER_AGENT_ID: "agent_x", AIRPROMPTER_ENVIRONMENT: "dev", AIRPROMPTER_HOSTED_ENVIRONMENT: "dev",
  AIRPROMPTER_ROOT_URL: "https://edge.example/roots/dev/root.json", AIRPROMPTER_EDGE_POINTER_URL: "https://edge.example/g/tok/generation.json", AIRPROMPTER_ROOT_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y" }), PULL_INTERVAL_SECONDS: "60",
};

test("readPullerEnv: every name, the parameter is a name, a key in the environment is refused, the interval has a floor", () => {
  const env = readPullerEnv(ENV);
  assert.equal(env.agentKeyParameter, "/zudocs/dev/agent-key");
  assert.equal(env.pullIntervalSeconds, 60);
  assert.equal(env.airprompter.edgePointerUrl, "https://edge.example/g/tok/generation.json");
  assert.equal(env.region, "ap-southeast-1");
  assert.throws(() => readPullerEnv({ ...ENV, EXCHANGE_BUCKET: "" }), /EXCHANGE_BUCKET is missing/);
  assert.throws(() => readPullerEnv({ ...ENV, AIRPROMPTER_AGENT_KEY: "apa_x" }), /never from a variable/);
  assert.throws(() => readPullerEnv({ ...ENV, AGENT_KEY_PARAMETER: "apa_x" }), /never a key/);
  assert.throws(() => readPullerEnv({ ...ENV, PULL_INTERVAL_SECONDS: "5" }), /at least 30/);
  assert.throws(() => readPullerEnv({ ...ENV, AIRPROMPTER_ENVIRONMENT: "qa" }), /dev, staging or prod/);
});

const releaseKey = { organizationId: "org-1", agentId: "agent_x", target: "dev" as const, region: "ap-southeast-1" };
const edge1 = { pointerUrl: "https://edge.example/g/tok/generation.json", pointerEtag: '"p1"', manifestEtag: '"m1"', lastOriginAt: "2026-09-18T20:00:00.000Z" };

interface World {
  deps: PullerDeps;
  datastore: ReleaseDatastore;
  state: PullerState;
  version: string | null;
  status: Map<string, Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  pulls: Array<Pick<PullToDatastoreInput, "skipPointer" | "distributionPublicKey" | "region">>;
  publicKey: PublicKeyRead;
  statusDoc: string | null;
  keyReadable: boolean;
  nextResults: PullToDatastoreResult[];
  beforeWrite: (() => void) | null;
  statusDenied: string | null;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    datastore: kvReleaseDatastore(new MemoryKvStore()),
    state: { ...EMPTY_STATE },
    version: null,
    status: new Map(),
    events: [],
    pulls: [],
    publicKey: { key: null, reason: "absent" },
    statusDoc: null,
    keyReadable: true,
    nextResults: [],
    beforeWrite: null,
    statusDenied: null,
    deps: null as never,
    ...over,
  };
  const env: PullerEnv = readPullerEnv(ENV);
  const remembered: PullerStateStore = {
    read: async () => ({ state: { ...w.state, nudgeIds: [...w.state.nudgeIds] }, version: w.version }),
    write: async (state, expected) => {
      w.beforeWrite?.();
      if (expected !== w.version) throw new RaceLost(expected);
      w.state = state;
      w.version = w.version === null ? '"1"' : `"${Number(w.version.replaceAll('"', "")) + 1}"`;
      return w.version;
    },
  };
  const exchange: Exchange = {
    readPublicKey: async () => w.publicKey,
    readStatusDoc: async () => ({ doc: w.statusDoc ? (JSON.parse(w.statusDoc) as never) : null, denied: w.statusDenied }),
  };
  const desk: DeskTables = {
    updateStatus: async (hostId, fields) => { w.status.set(hostId, { ...(w.status.get(hostId) ?? {}), ...fields }); },
    appendEvent: async (event) => { w.events.push(event); },
  };
  w.deps = {
    env,
    datastore: w.datastore,
    remembered,
    exchange,
    desk,
    agentKey: async () => { if (!w.keyReadable) throw Object.assign(new Error("ParameterNotFound"), { name: "ParameterNotFound" }); return "apa_test"; },
    fetch: (async () => { throw new Error("no network in a test"); }) as never,
    now: () => "2026-09-18T20:00:00.000Z",
    pull: async (input) => {
      w.pulls.push({ skipPointer: input.skipPointer, distributionPublicKey: input.distributionPublicKey, region: input.region });
      const next = w.nextResults.shift();
      if (!next) throw new Error("the test queued no pull result");
      if (next.status === "ok") {
        await input.datastore.putRelease(releaseKey, { generation: next.generation, releaseDigest: next.releaseDigest, bundle: JSON.stringify(next.bundle), createdAt: next.createdAt, notAfter: next.notAfter, rollout: { applyPolicy: "auto", experiments: [], disabled: { agent: false, slots: [], arms: [] } } });
        await input.datastore.putEdge(releaseKey, next.edge);
      } else if (next.status === "unchanged" || next.status === "nothing_promoted") {
        await input.datastore.putEdge(releaseKey, next.edge);
      }
      return next;
    },
  };
  return w;
}

const okResult = (generation: number, digest = `sha256:${generation}`): Extract<PullToDatastoreResult, { status: "ok" }> => ({ status: "ok", bundle: { v: 1 } as never, manifest: {} as never, generation, releaseDigest: digest, createdAt: "2026-09-18T20:00:00.000Z", notAfter: "2026-12-17T20:00:00.000Z", trustedRoot: {} as never, edge: edge1, key: releaseKey, stored: true });

test("a first tick with no key in the exchange pulls plaintext and the datastore holds the generation", async () => {
  const w = world({ nextResults: [okResult(3)] });
  const result = await pass(w.deps, { action: "tick" });
  assert.equal(result.outcome, "ok");
  assert.equal(result.generation, 3);
  assert.equal(w.pulls[0]!.skipPointer, false);
  assert.equal(w.pulls[0]!.region, "ap-southeast-1");
  assert.equal(w.pulls[0]!.distributionPublicKey, null);
  const held = await w.datastore.latest(releaseKey);
  assert.equal(held?.generation, 3);
  assert.equal(w.events[0]!.kind, "bundle_pulled");
  assert.equal((w.status.get("ap-southeast-1/puller")!.status as { generation: number }).generation, 3);
});

test("the next tick is unchanged via the pointer: no new event; the stretched ticks are skipped, then the next tick pulls", async () => {
  const w = world({ nextResults: [{ status: "unchanged", via: "pointer", edge: edge1, key: releaseKey, stored: false }, okResult(4)] });
  await pass(w.deps, { action: "tick" });
  assert.equal(w.events.length, 0);
  assert.ok(w.state.skipTicks > 0);
  const skipped = await pass(w.deps, { action: "tick" });
  assert.equal(skipped.plan, "backoff");
  assert.equal(w.pulls.length, 1);
  w.state = { ...w.state, skipTicks: 0 };
  await pass(w.deps, { action: "tick" });
  assert.equal(w.pulls.length, 2);
  assert.equal((await w.datastore.latest(releaseKey))?.generation, 4);
});

test("a nudge pulls with skipPointer whatever the backoff, counts itself, and is a timeline row", async () => {
  const w = world({ state: { ...EMPTY_STATE, skipTicks: 4 }, nextResults: [okResult(5)] });
  await pass(w.deps, { Records: [{ messageId: "m1", body: JSON.stringify({ by: "seth", at: "2026-09-18T19:59:00.000Z" }) }] });
  assert.equal(w.pulls[0]!.skipPointer, true);
  assert.equal(w.state.nudges, 1);
  assert.equal(w.events[0]!.kind, "nudged");
  assert.equal(w.events[1]!.kind, "bundle_pulled");
});

test("a published key is what the bundle is sealed to; a malformed key stops the puller", async () => {
  const pair = generateX25519KeyPair();
  const keyId = distributionKeyId(pair.publicRaw);
  const w = world({ publicKey: { key: { keyId, raw: pair.publicRaw }, reason: null }, nextResults: [okResult(3)] });
  await pass(w.deps, { action: "tick" });
  assert.equal(w.pulls[0]!.distributionPublicKey, pair.publicRaw);
  assert.equal((w.events[0] as { sealed: boolean }).sealed, true);
  const malformed = world({ publicKey: { key: null, reason: "publicKey is not a 32-byte X25519 key" }, nextResults: [okResult(4)] });
  const skipped = await pass(malformed.deps, { action: "tick" });
  assert.equal(skipped.plan, "key_malformed");
  assert.equal(malformed.pulls.length, 0);
});

test("a refusal is one timeline row per change of outcome, and a datastore outage is failing health", async () => {
  const refused: PullToDatastoreResult = { status: "refused", reason: "plaintext_not_allowed", edge: edge1, key: releaseKey, stored: false };
  const w = world({ nextResults: [refused, refused, { status: "datastore_unavailable", key: releaseKey, stage: "write", detail: "slow", stored: false }] });
  await pass(w.deps, { action: "tick" });
  w.state = { ...w.state, skipTicks: 0 };
  await pass(w.deps, { action: "tick" });
  const refusals = w.events.filter((event) => event.kind === "pull_failed" && event.outcome === "refused");
  assert.equal(refusals.length, 1);
  w.state = { ...w.state, skipTicks: 0 };
  await pass(w.deps, { action: "tick" });
  const row = w.status.get("ap-southeast-1/puller")!;
  assert.equal((row.healthz as { status: string }).status, "failing");
});

test("an unreadable Agent key: a tick pulls nothing and writes a failing row; a nudge throws so the queue retries it", async () => {
  const w = world({ keyReadable: false, nextResults: [okResult(3)] });
  const tick = await pass(w.deps, { action: "tick" });
  assert.equal(tick.outcome, null);
  assert.equal(w.pulls.length, 0);
  assert.equal((w.status.get("ap-southeast-1/puller")!.healthz as { status: string }).status, "failing");
  await assert.rejects(() => pass(w.deps, { Records: [{ messageId: "m", body: "{}" }] }), /unreadable/);
  assert.equal(w.state.nudges, 0);
});

test("two invocations at once: a tick that loses the state's version stops cleanly; a nudge that loses runs once more", async () => {
  const tick = world({ nextResults: [okResult(3)], beforeWrite: () => { tick.version = '"stolen"'; tick.beforeWrite = null; } });
  const lost = await runOnce(tick.deps, { action: "tick" });
  assert.equal(lost.plan, "race_lost");
  const nudge = world({ nextResults: [okResult(6)], beforeWrite: () => { nudge.version = '"stolen"'; nudge.beforeWrite = null; } });
  const again = await runOnce(nudge.deps, { Records: [{ messageId: "m9", body: JSON.stringify({ by: "seth" }) }] });
  assert.equal(again.generation, 6);
  assert.equal(nudge.state.nudges, 1);
});

test("the air-gapped host's document is mirrored when it changed, and not again for the same document", async () => {
  const doc = buildStatusDoc({ hostId: "ap-southeast-1/airgap", region: "ap-southeast-1", sdk: "agent-sdk-ts/0.2.15", startedAt: "2026-09-18T19:50:00.000Z", now: "2026-09-18T19:59:00.000Z", seq: 3, ec2: { instanceId: "i-1", availabilityZone: "ap-southeast-1a" }, keyId: "k1", phase: "serving", status: { instanceId: "inst", generation: 3, applyState: "active" } as never, healthz: { ok: true, status: "ok", reasons: [] } as never, applies: [{ at: "2026-09-18T19:51:00.000Z", generation: 3, outcome: "activated", reason: null, detail: null, source: "datastore", object: null }], startFailure: null, renders: { count: 1, lastAt: null, last: null, observation: "refused" }, export: null, probe: null, log: [] });
  const w = world({ statusDoc: JSON.stringify(doc), nextResults: [{ status: "unchanged", via: "pointer", edge: edge1, key: releaseKey, stored: false }] });
  await pass(w.deps, { action: "tick" });
  assert.equal(w.status.get("ap-southeast-1/airgap")!.kind, "airgapped");
  const mirrored = w.events.filter((event) => event.host === "ap-southeast-1/airgap").length;
  assert.ok(mirrored > 0);
  const again = world({ ...w, statusDoc: JSON.stringify(doc), state: w.state, version: w.version, datastore: w.datastore, nextResults: [{ status: "unchanged", via: "pointer", edge: edge1, key: releaseKey, stored: false }], events: [], status: new Map() });
  await pass(again.deps, { action: "tick" });
  assert.equal(again.events.filter((event) => event.host === "ap-southeast-1/airgap").length, 0);
});
