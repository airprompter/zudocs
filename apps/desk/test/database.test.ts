import assert from "node:assert/strict";
import { test } from "node:test";
import { eventFields, recordTime, runFields } from "../src/components/Database";
import type { Run } from "../src/api";

test("record summaries retain saved provenance and settings without prompt content or run references", () => {
  const run: Run = { runId: "saved", ticketId: "T-1052", customerId: "customer", at: "2026-10-04T02:29:01Z", by: "owner", host: "us-east-1/lambda", kind: "run", generation: 87, applyState: "active", durationMs: 100, capUsed: 1, ok: true, triage: null, reply: null, handoff: null,
    steps: [{ step: "reply", tag: "support.reply", versionId: "rev-42", generation: 87, arm: "none", model: "amazon.nova-2-lite", runRef: "REFERENCE_SENTINEL", rendered: { text: "CONTENT_SENTINEL", variables: [], inference: { temperatureMilli: 300, maxOutputTokens: 600 } }, output: "OUTPUT_SENTINEL", observation: null, checks: [], judge: null, error: null, costUsd: null }] };
  const projected = runFields(run);
  const json = JSON.stringify(projected);
  assert.equal(projected.runId, run.runId);
  assert.match(json, /rev-42/);
  assert.match(json, /temperatureMilli/);
  for (const excluded of ["REFERENCE_SENTINEL", "CONTENT_SENTINEL", "OUTPUT_SENTINEL"]) assert.equal(json.includes(excluded), false);
});

test("activity inspector only accepts known metadata fields", () => {
  assert.deepEqual(eventFields({ id: "e", at: "now", kind: "ticket_run", host: "us-east-1/lambda", generation: 87, versionId: "rev-42", stdout: "UNEXPECTED_PAYLOAD", arbitrary: "UNEXPECTED_PAYLOAD" }),
    { id: "e", at: "now", kind: "ticket_run", host: "us-east-1/lambda", generation: 87, versionId: "rev-42" });
});

test("record dates stay in UTC at a local date boundary", () => {
  assert.equal(recordTime("2026-10-04T00:01:00Z"), "2026-10-04 · 00:01:00Z");
  assert.equal(recordTime("2026-10-03T23:59:00Z"), "2026-10-03 · 23:59:00Z");
});
