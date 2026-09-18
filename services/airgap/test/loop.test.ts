import assert from "node:assert/strict";
import { test } from "node:test";
import type { AirgapStatusDoc, ApplyRecord } from "../src/status.js";
import { createRuntime, PROBE_TAG, PROBE_TICKET, START_RETRY_MS, type Agent, type NewestRow, type RuntimePorts } from "../src/runtime.js";

interface Fake {
  ports: RuntimePorts;
  rows: NewestRow[];
  objects: Map<string, string>;
  vendored: string | null;
  docs: AirgapStatusDoc[];
  log: Array<Record<string, unknown>>;
  startAnswers: Array<{ agent: Agent } | { agent: null; code: string | null; message: string }>;
  starts: number;
  clock: number;
}

function fakeAgent(generation: number, outcomes: Array<{ outcome: string; generation?: number; reason?: string }> = []): Agent & { reports: unknown[]; applied: string[] } {
  const reports: unknown[] = [];
  const applied: string[] = [];
  let current = generation;
  return {
    reports,
    applied,
    get generation() { return current; },
    instanceId: "inst-1",
    status: () => ({ generation: current, applyState: "active", source: "vendored_bundle", storageProtection: "file_key" }) as never,
    healthz: () => ({ ok: true, status: "ok", reasons: [] }) as never,
    async applyBundle(text) {
      applied.push(text);
      const next = outcomes.shift() ?? { outcome: "activated", generation: current + 1 };
      if (next.outcome === "activated") current = next.generation ?? current + 1;
      return next as never;
    },
    prompt: (tag, { subject }) => ({ renderAsync: async () => ({ tag, versionId: "rev-2", arm: subject === "cust-2002" ? "candidate" : "none", model: "amazon.nova-micro", text: `rendered ${tag}` }) }),
    report: (observation) => { reports.push(observation); },
    stop: async () => undefined,
  };
}

function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = { rows: [], objects: new Map(), vendored: null, docs: [], log: [], startAnswers: [], starts: 0, clock: Date.parse("2026-09-18T20:00:00.000Z"), ports: null as never, ...over };
  f.ports = {
    hostId: "ap-southeast-1/airgap",
    region: "ap-southeast-1",
    keyId: "k1",
    sdk: "agent-sdk-ts/0.2.14",
    ec2: { instanceId: "i-1", availabilityZone: "ap-southeast-1a" },
    newestRow: async () => [...f.rows].sort((a, b) => b.generation - a.generation)[0] ?? null,
    fetchBundle: async (object) => { const text = f.objects.get(object); if (text === undefined) throw new Error(`${object}: no such object`); return text; },
    start: async () => { f.starts += 1; return f.startAnswers.shift() ?? { agent: null, code: "no_verified_release", message: "nothing to start on" }; },
    writeVendored: (text) => { f.vendored = text; },
    putStatus: async (doc) => { f.docs.push(doc); },
    readExport: () => null,
    readProbe: () => null,
    now: () => new Date(f.clock).toISOString(),
    log: (event) => { f.log.push(event); },
    recentLog: () => f.log.slice(-30),
    takeVendoredOutcomes: () => [],
  };
  return f;
}

const row = (generation: number, keyId: string | null): NewestRow => ({ generation, releaseDigest: `sha256:${generation}`, keyId, object: `releases/${generation}-${keyId ?? "plain"}.apbundle`, pulledAt: "t" });

test("a fresh host: nothing to boot on; a plaintext or foreign-key row is waited on (said once); the first row sealed to its key becomes the vendored bundle the SDK starts on", async () => {
  const f = fake({ rows: [row(3, null)] });
  f.objects.set("releases/3-plain.apbundle", "PLAIN");
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  assert.equal(runtime.agent, null);
  assert.equal(f.log.at(-1)?.event, "sdk_not_started", "no store, no bundle: the SDK says so");
  assert.equal(runtime.startFailure, null, "not a bundle's failure: nothing was handed over");
  await runtime.applyTick();
  await runtime.applyTick();
  assert.equal(f.log.filter((e) => e.event === "waiting_for_reseal").length, 1, "said once, not every tick");
  assert.equal(f.vendored, null, "a plaintext bundle is not for this host");
  await runtime.writeStatus();
  assert.equal(f.docs.at(-1)?.phase, "awaiting_bundle");
  assert.deepEqual(f.docs.at(-1)?.waitingFor, { newest: { generation: 3, keyId: null } });
  f.rows = [row(3, "k1")];
  f.objects.set("releases/3-k1.apbundle", "SEALED-3");
  const agent = fakeAgent(3);
  f.startAnswers.push({ agent });
  await runtime.applyTick();
  assert.equal(f.vendored, "SEALED-3", "the first sealed bundle is the vendored floor");
  assert.equal(runtime.agent, agent);
  assert.equal(runtime.attempted, 3);
  assert.equal(runtime.phase, "serving");
  assert.equal(f.docs.at(-1)?.phase, "serving", "the status document was written on the transition");
  await runtime.applyTick();
  assert.equal(agent.applied.length, 0, "the same row is not handed over again");
});

test("with the SDK running, a newer row goes to applyBundle: an activation refreshes the vendored file; a refusal is recorded and the row is not retried; the render probe files a refused observation", async () => {
  const agent = fakeAgent(3, [{ outcome: "activated", generation: 4 }, { outcome: "refused", generation: 5, reason: "expired" }]);
  const f = fake({ rows: [row(3, "k1")], startAnswers: [{ agent }], vendored: "SEALED-3" });
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  assert.equal(runtime.attempted, 3, "what the store holds is what was handed over");
  f.rows.push(row(4, "k1"));
  f.objects.set("releases/4-k1.apbundle", "SEALED-4");
  await runtime.applyTick();
  assert.deepEqual(agent.applied, ["SEALED-4"]);
  assert.equal(f.vendored, "SEALED-4", "an activation refreshes the floor");
  assert.equal(runtime.applies.at(-1)?.outcome, "activated");
  assert.equal(runtime.applies.at(-1)?.source, "exchange");
  f.rows.push(row(5, "k1"));
  f.objects.set("releases/5-k1.apbundle", "SEALED-5");
  await runtime.applyTick();
  assert.equal(runtime.applies.at(-1)?.outcome, "refused");
  assert.equal(runtime.applies.at(-1)?.reason, "expired");
  assert.equal(f.vendored, "SEALED-4", "a refused bundle never becomes the floor");
  assert.equal(runtime.attempted, 5, "handed over once; the SDK's answer stands");
  await runtime.applyTick();
  assert.equal(agent.applied.length, 2, "not retried every tick");
  await runtime.renderTick();
  await runtime.renderTick();
  assert.equal(runtime.renders.count, 2);
  assert.deepEqual(agent.reports[0], { tag: PROBE_TAG, versionId: "rev-2", arm: "none", model: "amazon.nova-micro", status: "refused", latencyMs: 0, usageSource: "unavailable" }, "refused, no latency, no usage: nothing invented");
  assert.equal((agent.reports[1] as { arm: string }).arm, "candidate", "the sticky arm resolves per customer id, as on every other host");
  assert.equal(runtime.renders.last?.subject, "cust-2002");
  assert.ok(!JSON.stringify(f.log).includes(PROBE_TICKET) && !JSON.stringify(f.log).includes("rendered support"), "no render text in the log");
  const doc = (await runtime.writeStatus(), f.docs.at(-1)!);
  assert.equal(doc.renders.observation, "refused");
  assert.equal(doc.status?.generation, 4);
});

test("a bundle the SDK cannot start on is recorded, not forgotten: the same row is tried again after the cooldown, or as soon as a newer row appears", async () => {
  const f = fake({ rows: [row(3, "k1")], startAnswers: [{ agent: null, code: "no_verified_release", message: "nothing to start on" }, { agent: null, code: "store_corrupt", message: "store.json is not readable" }] });
  f.objects.set("releases/3-k1.apbundle", "SEALED-3");
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  await runtime.applyTick();
  assert.equal(f.starts, 2, "boot, then the first bundle");
  assert.equal(runtime.agent, null);
  assert.equal(runtime.attempted, 0, "not marked as handed over");
  assert.deepEqual(runtime.startFailure, { at: "2026-09-18T20:00:00.000Z", generation: 3, releaseDigest: "sha256:3", code: "store_corrupt", message: "store.json is not readable" });
  await runtime.applyTick();
  assert.equal(f.starts, 2, "inside the cooldown the same row is not tried again");
  await runtime.writeStatus();
  assert.equal(f.docs.at(-1)?.startFailure?.code, "store_corrupt", "the document says why");
  f.clock += START_RETRY_MS + 1;
  f.startAnswers.push({ agent: null, code: "store_corrupt", message: "still" });
  await runtime.applyTick();
  assert.equal(f.starts, 3, "after the cooldown it is tried again");
  f.rows.push(row(4, "k1"));
  f.objects.set("releases/4-k1.apbundle", "SEALED-4");
  const agent = fakeAgent(4);
  f.startAnswers.push({ agent });
  await runtime.applyTick();
  assert.equal(f.starts, 4, "a newer row is tried at once");
  assert.equal(runtime.agent, agent);
  assert.equal(runtime.startFailure, null);
  assert.equal(f.vendored, "SEALED-4");
});

test("a host that restarted with a store boots on it without the table; the vendored outcomes the SDK's logger reported are recorded; stop writes a last document", async () => {
  const agent = fakeAgent(3);
  const vendoredOutcomes: ApplyRecord[] = [{ at: "t", generation: 3, outcome: "unchanged", reason: null, detail: null, source: "vendored", object: null }];
  const f = fake({ startAnswers: [{ agent }] });
  f.ports.takeVendoredOutcomes = () => vendoredOutcomes.splice(0);
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  assert.equal(runtime.agent, agent);
  assert.equal(runtime.phase, "serving");
  assert.deepEqual(runtime.applies.map((a) => a.outcome), ["unchanged"]);
  await runtime.applyTick();
  assert.equal(f.log.some((e) => e.event === "apply_tick_failed"), false, "an empty table is nothing to do");
  await runtime.stop("SIGTERM");
  assert.equal(f.docs.length, 1);
  assert.equal(f.log.at(-1)?.event, "stopping");
});
