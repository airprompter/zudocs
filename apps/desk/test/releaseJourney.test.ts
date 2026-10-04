import assert from "node:assert/strict";
import { test } from "node:test";
import type { Approval, HostStatus, Run, TimelineEvent } from "../src/api";
import { journeySnapshot } from "../src/components/ReleaseJourney";
import { replyPair } from "../src/components/ReplyComparison";

const at = "2026-10-03T12:00:00.000Z";
const host = (generation: number, stagedGeneration: number | null): HostStatus => ({
  hostId: "eu-west-1/ec2", region: "eu-west-1", kind: "daemon", sdk: "agent-sdk-ts/0.3.0", writtenAt: at,
  status: { generation, stagedGeneration, applyState: stagedGeneration ? "awaiting_unlock" : "active" },
  healthz: { status: "ok" },
  container: { instanceId: "i-test", coldStart: false, startedAt: at, invocations: 1 },
});
const approval = (decision: Approval["decision"]): Approval => ({
  approvalId: "a-87", hostId: "eu-west-1/ec2", generation: 87, releaseDigest: "sha256:example", stagedAt: at,
  unlockRequest: null, decision, decidedBy: decision === "pending" ? null : "owner", decidedAt: decision === "pending" ? null : at,
  activatedAt: decision === "activated" ? at : null, outcome: null, updatedAt: at,
});
const run = (generation: number, time: string, runHost = "eu-west-1/ec2", route: Run["route"] = "bedrock"): Run => ({
  runId: `${runHost}-${generation}-${time}`, ticketId: "T-1041", customerId: "c", at: time, by: "worker", host: runHost, kind: "run", route,
  generation, applyState: "active", durationMs: 100, capUsed: 1, ok: true, triage: null, reply: "Answer", handoff: null,
  steps: [{ step: "reply", tag: "support.reply", versionId: generation === 87 ? "rev-4" : "rev-3", arm: "none", model: "m", generation,
    runRef: null, rendered: null, output: "Answer", observation: null, checks: [{ name: "signed", kind: "must_match", verdict: "pass" }], costUsd: null, judge: null, error: null }],
});

test("journey keeps a staged release separate from the older reply until the host activates it", () => {
  const stagedEvent: TimelineEvent = { at, kind: "release_staged", host: "eu-west-1/ec2", generation: 87 };
  const pending = journeySnapshot(host(86, 87), [approval("pending")], [stagedEvent], [run(86, at)], "T-1041", Date.parse(at) + 1000)!;
  assert.equal(pending.generation, 87);
  assert.equal(pending.active, 86);
  assert.equal(pending.phases[2]?.state, "waiting");
  assert.match(pending.phases[3]!.detail, /still serves release #86/);
  const active = journeySnapshot(host(87, null), [approval("activated")], [stagedEvent], [run(87, at)], "T-1041", Date.parse(at) + 1000)!;
  assert.equal(active.phases[2]?.state, "done");
  assert.equal(active.phases[3]?.state, "done");
  assert.match(active.phases[3]!.detail, /rev-4; 1\/1 checks passed/);
});

test("journey keeps a reply written before a daemon restart", () => {
  const earlier = "2026-10-02T12:00:00.000Z";
  const snapshot = journeySnapshot(host(86, null), [], [], [run(86, earlier)], "T-1041", Date.parse(at) + 1000)!;
  assert.equal(snapshot.phases[3]?.state, "done");
  assert.equal(snapshot.phases[3]?.at, earlier);
  assert.match(snapshot.phases[3]!.detail, /rev-3; 1\/1 checks passed/);
});

test("journey names a reply that predates this approval without claiming it proves activation", () => {
  const earlier = "2026-10-02T12:00:00.000Z";
  const active = journeySnapshot(host(87, null), [approval("activated")], [], [run(87, earlier)], "T-1041", Date.parse(at) + 1000)!;
  assert.equal(active.phases[3]?.state, "waiting");
  assert.equal(active.phases[3]?.at, earlier);
  assert.match(active.phases[3]!.detail, /earlier reply from release #87/);
  assert.match(active.phases[3]!.detail, /predates this approval/);
});

test("reply comparison requires two releases on the same ticket host and route", () => {
  const before = run(86, "2026-10-03T12:00:00.000Z");
  const after = run(87, "2026-10-03T13:00:00.000Z");
  assert.equal(replyPair([before, run(86, "2026-10-03T12:30:00.000Z")]), null);
  assert.equal(replyPair([before, run(87, "2026-10-03T13:00:00.000Z", "us-east-1/lambda")]), null);
  assert.equal(replyPair([before, run(87, "2026-10-03T13:00:00.000Z", "eu-west-1/ec2", "openai")]), null);
  assert.equal(replyPair([before, { ...after, ticketId: "T-1052" }]), null);
  assert.deepEqual(replyPair([before, after])?.before.run.runId, before.runId);
  assert.deepEqual(replyPair([before, after])?.after.run.runId, after.runId);
});
