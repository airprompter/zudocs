/**
 * The demo's pure parts: the ramp is what the platform accepts (every step below 100 % holds, the last is 100 %),
 * the fleet-agreement check ignores a stale optional host and names the disagreeing ones, the edge pointer's
 * generation is read without a key and an unreadable pointer is null rather than a guess, and the vendored-bundle
 * check refuses the support agent's bundle and any foreign slot.
 *
 * @example
 * ```sh
 * node --test scripts/test/demo.test.mjs
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { vendoredBreaches } from "../check-vendored.mjs";
import { RAMP, armsByCustomer, edgeGeneration, fleetAgreement, releaseLine } from "../lib/demo.mjs";

test("the ramp: every step short of 100 % holds for at least the platform's minimum; the last step is everyone", () => {
  assert.equal(RAMP[RAMP.length - 1].weightBps, 10000);
  for (const step of RAMP.slice(0, -1)) assert.ok(step.holdMinutes >= 10, "a held step");
  assert.deepEqual(RAMP.map((s) => s.weightBps), [1000, 5000, 10000], "10 % → 50 % → 100 %");
  assert.ok(RAMP.every((s, i) => i === 0 || s.weightBps > RAMP[i - 1].weightBps), "strictly increasing");
});

test("fleet agreement: every fresh row at the generation; a stale optional host is ignored; disagreement is named", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  const row = (hostId, generation, minutesAgo, kind = "lambda") => ({ hostId, kind, writtenAt: new Date(now - minutesAgo * 60_000).toISOString(), status: { generation, applyState: "active", stagedGeneration: null } });
  const agree = fleetAgreement([row("us-east-1/lambda", 9, 1), row("eu-west-1/ec2", 9, 1, "daemon"), row("ap-southeast-1/puller", 9, 3, "puller"), row("ap-southeast-1/airgap", 4, 120, "airgapped")], 9, { now });
  assert.equal(agree.agree, true, "the air-gapped host's row is two hours old: it is down, not behind");
  const behind = fleetAgreement([row("us-east-1/lambda", 9, 1), row("eu-west-1/ec2", 8, 1, "daemon")], 9, { now });
  assert.equal(behind.agree, false);
  assert.deepEqual(behind.disagree.map((r) => r.hostId), ["eu-west-1/ec2"]);
  const airgapUp = fleetAgreement([row("us-east-1/lambda", 9, 1), row("ap-southeast-1/airgap", 8, 2, "airgapped")], 9, { now });
  assert.equal(airgapUp.agree, false, "an air-gapped host that is up and behind counts");
  assert.equal(fleetAgreement([], 9, { now }).agree, false, "nothing reporting is no agreement");
  assert.deepEqual(armsByCustomer([{ customerId: "c1", tag: "support.reply", generation: 5, arms: { a: "control" }, consistent: true }, { customerId: "c1", tag: "support.triage", generation: 5, arms: { a: "candidate" }, consistent: true }], "support.reply"), { c1: { arms: { a: "control" }, consistent: true, generation: 5 } });
  const dialled = [{ customerId: "c1", tag: "support.reply", generation: 6, arms: { a: "candidate" }, consistent: true }, { customerId: "c1", tag: "support.reply", generation: 5, arms: { a: "control" }, consistent: true }];
  assert.deepEqual(armsByCustomer(dialled, "support.reply"), { c1: { arms: { a: "candidate" }, consistent: true, generation: 6 } }, "the newest release's row wins after a dial");
  assert.deepEqual(armsByCustomer(dialled, "support.reply", 5), { c1: { arms: { a: "control" }, consistent: true, generation: 5 } }, "a generation asked for is the one answered");
});

test("the edge pointer: its generation, read with no key; no pointer, an error status, a malformed body or a network failure is null", async () => {
  const calls = [];
  const answer = (status, body) => async (url, init) => { calls.push({ url, init }); return { status, json: async () => body }; };
  assert.equal(await edgeGeneration("https://edge.test/g/t/generation.json", answer(200, { generation: 88, releaseDigest: "sha256:a" })), 88);
  assert.equal(calls[0].init, undefined, "no headers, no key: a public CDN read");
  assert.equal(await edgeGeneration(null, answer(200, { generation: 1 })), null);
  assert.equal(await edgeGeneration("https://edge.test/x", answer(403, {})), null);
  assert.equal(await edgeGeneration("https://edge.test/x", answer(200, { generation: "eighty" })), null);
  assert.equal(await edgeGeneration("https://edge.test/x", async () => { throw new Error("offline"); }), null);
  assert.equal(releaseLine(7, "sha256:0123456789abcdef0123"), "#7 sha256:0123456789ab…");
});

test("the vendored bundle: the CI agent's only, one placeholder slot, verified", () => {
  const config = { organizationId: "org", agentId: "agent_support", ciAgentId: "agent_ci" };
  const meta = { kind: "airprompter-bundle-meta", organizationId: "org", agentId: "agent_ci", generation: 1 };
  assert.deepEqual(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: 1 } }, config }), []);
  assert.deepEqual(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: [{ tag: "ci.vendoring" }] } }, config }), []);
  assert.match(vendoredBreaches({ meta: { ...meta, agentId: "agent_support" }, verify: { ok: true, manifest: { slots: 1 } }, config }).join("\n"), /support agent/);
  assert.match(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: 4 } }, config }).join("\n"), /carries 4 slot/);
  assert.match(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: [{ tag: "support.reply" }] } }, config }).join("\n"), /outside the CI agent's: support.reply/);
  assert.match(vendoredBreaches({ meta, verify: { ok: false, step: "root", reason: "root_scope_mismatch", manifest: { slots: 1 } }, config }).join("\n"), /root_scope_mismatch/);
  assert.match(vendoredBreaches({ meta, verify: null, config: { ...config, ciAgentId: null } }).join("\n"), /no ciAgentId/);
});
