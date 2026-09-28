/**
 * The air-gapped loop over fakes: start, hydrate, the render probe, the cooldown.
 *
 * @example
 * ```sh
 * npm test --workspace services/airgap
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HydrateOutcome } from "@airprompter/agent-sdk";
import { createRuntime, PROBE_TAG, PROBE_TICKET, START_RETRY_MS, type Agent, type RuntimePorts } from "../src/runtime.js";
import type { AirgapStatusDoc } from "../src/status.js";

interface Fake {
  ports: RuntimePorts;
  docs: AirgapStatusDoc[];
  log: Array<Record<string, unknown>>;
  startAnswers: Array<{ agent: Agent } | { agent: null; code: string | null; message: string }>;
  starts: number;
  clock: number;
}

function fakeAgent(generation: number, outcomes: HydrateOutcome[] = []): Agent & { reports: unknown[]; hydrations: number } {
  const reports: unknown[] = [];
  let current = generation;
  let hydrations = 0;
  return {
    reports,
    get hydrations() { return hydrations; },
    get generation() { return current; },
    instanceId: "inst-1",
    status: () => ({ generation: current, applyState: "active", source: "store", storageProtection: "file_key", datastore: { region: "ap-southeast-1", lastHydrateAt: null, lastOutcome: current > 0 ? "unchanged" : "empty", newestGeneration: current, rowsFrom: "region", rollback: null } }) as never,
    healthz: () => ({ ok: true, status: "ok", reasons: [] }) as never,
    async hydrate() {
      hydrations += 1;
      const next = outcomes.shift() ?? { outcome: "unchanged" as const, generation: current };
      if ((next.outcome === "activated" || next.outcome === "rolled_back") && next.generation) current = next.generation;
      return next;
    },
    prompt: (tag, { subject }) => ({ renderAsync: async () => ({ tag, versionId: "rev-2", arm: subject === "cust-2002" ? "candidate" : "none", model: "amazon.nova-micro", text: `rendered ${tag}` }) }),
    report: (observation) => { reports.push(observation); },
    stop: async () => undefined,
  };
}

function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = { docs: [], log: [], startAnswers: [], starts: 0, clock: Date.parse("2026-09-18T20:00:00.000Z"), ports: null as never, ...over };
  f.ports = {
    hostId: "ap-southeast-1/airgap",
    region: "ap-southeast-1",
    keyId: "k1",
    sdk: "agent-sdk-ts/0.2.15",
    ec2: { instanceId: "i-1", availabilityZone: "ap-southeast-1a" },
    start: async () => {
      f.starts += 1;
      const answer = f.startAnswers.shift();
      if (!answer) return { agent: null, code: "no_verified_release", message: "the datastore holds no release" };
      return answer;
    },
    putStatus: async (doc) => { f.docs.push(doc); },
    readExport: () => null,
    readProbe: () => null,
    now: () => new Date(f.clock).toISOString(),
    log: (event) => { f.log.push(event); },
    recentLog: () => f.log,
  };
  return f;
}

test("a fresh host has nothing to boot on; the next tick starts once the datastore has a release", async () => {
  const agent = fakeAgent(3);
  const f = fake({ startAnswers: [{ agent: null, code: "no_verified_release", message: "empty" }, { agent }] });
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  assert.equal(runtime.agent, null);
  assert.equal(runtime.phase, "awaiting_bundle");
  await runtime.hydrateTick();
  assert.equal(runtime.agent, agent);
  assert.equal(runtime.phase, "serving");
  assert.equal(f.docs.at(-1)?.phase, "serving");
});

test("each tick hydrates, and the render probe files a refused observation", async () => {
  const agent = fakeAgent(3, [{ outcome: "activated", generation: 4 }, { outcome: "refused", generation: 5, reason: "expired" }]);
  const f = fake({ startAnswers: [{ agent }] });
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  assert.equal(runtime.phase, "serving");
  await runtime.hydrateTick();
  assert.equal(runtime.applies.at(-1)?.outcome, "activated");
  assert.equal(runtime.applies.at(-1)?.source, "datastore");
  assert.equal(agent.generation, 4);
  await runtime.hydrateTick();
  assert.equal(runtime.applies.at(-1)?.outcome, "refused");
  assert.equal(runtime.applies.at(-1)?.reason, "expired");
  await runtime.renderTick();
  await runtime.renderTick();
  assert.equal(runtime.renders.count, 2);
  assert.deepEqual(agent.reports[0], { tag: PROBE_TAG, versionId: "rev-2", arm: "none", model: "amazon.nova-micro", status: "refused", latencyMs: 0, usageSource: "unavailable" });
  assert.equal((agent.reports[1] as { arm: string }).arm, "candidate");
  assert.equal(runtime.renders.last?.subject, "cust-2002");
  assert.ok(!JSON.stringify(f.log).includes(PROBE_TICKET) && !JSON.stringify(f.log).includes("rendered support"));
  await runtime.writeStatus();
  assert.equal(f.docs.at(-1)?.renders.observation, "refused");
});

test("a start the SDK refuses is retried after the cooldown; an empty datastore is retried on the next tick", async () => {
  const f = fake({ startAnswers: [{ agent: null, code: "no_verified_release", message: "empty" }] });
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  await runtime.hydrateTick();
  assert.equal(f.starts, 2, "an empty datastore is tried again on the next tick");
  const corrupt = fake({ startAnswers: [{ agent: null, code: "store_corrupt", message: "store.json is not readable" }] });
  const held = createRuntime(corrupt.ports);
  await held.boot();
  await held.hydrateTick();
  assert.equal(corrupt.starts, 1, "inside the cooldown a failed start is not tried again");
  assert.equal(held.startFailure?.code, "store_corrupt");
  corrupt.clock += START_RETRY_MS + 1;
  corrupt.startAnswers.push({ agent: null, code: "store_corrupt", message: "still" });
  await held.hydrateTick();
  assert.equal(corrupt.starts, 2, "after the cooldown it is tried again");
});

test("a host that restarted with a store boots on it; stop writes a last document", async () => {
  const agent = fakeAgent(3);
  const f = fake({ startAnswers: [{ agent }] });
  const runtime = createRuntime(f.ports);
  await runtime.boot();
  assert.equal(runtime.agent, agent);
  assert.equal(runtime.phase, "serving");
  assert.equal(runtime.applies.at(-1)?.outcome, "unchanged");
  await runtime.stop("SIGTERM");
  assert.equal(f.docs.length, 1);
  assert.equal(f.log.at(-1)?.event, "stopping");
});
