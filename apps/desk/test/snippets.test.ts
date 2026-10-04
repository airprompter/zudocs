/**
 * The drawer's slices equal the source they name, and the desk ships no inline style.
 *
 * @example
 * ```sh
 * npx tsx --test test/snippets.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractBalanced, extractLine } from "../src/excerpt";
import { AIRGAP_START, CLIENT_RUN, DAEMON_START, ENQUEUE_CALL, LAMBDA_START, POLICY_LINE, RUN_STEP, TELEMETRY_DAEMON } from "../src/snippets";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

test("each snippet is the source slice, not a shortened sample", () => {
  const runtime = read("services/desk-api/src/runtime.ts");
  const run = read("services/desk-api/src/run.ts");
  const api = read("apps/desk/src/api.ts");
  const worker = read("services/eu-host/src/worker.ts");
  const unit = read("services/eu-host/host/units/airprompterd.service");
  const airgap = read("services/airgap/src/runtime.ts");
  const metrics = read("apps/desk/src/components/Metrics.tsx");

  assert.equal(LAMBDA_START.text, extractBalanced(runtime, "const ap = await AirPrompterAgent.start({"));
  for (const needle of ["apiKey,", 'storageProtection: "kms"', 'mode: "on_invoke"', 'policy: "auto"', "teeFetch"]) {
    assert.ok(LAMBDA_START.text.includes(needle), needle);
  }

  assert.equal(RUN_STEP.text, extractBalanced(run, "const runStep = async"));
  for (const needle of ["handle.renderAsync", "callers.complete", "ap.checks(", "ap.judge("]) assert.ok(RUN_STEP.text.includes(needle), needle);

  assert.equal(CLIENT_RUN.text, extractLine(api, "runTicket:"));
  assert.ok(CLIENT_RUN.text.includes("/tickets/${encodeURIComponent(ticketId)}/run"));

  assert.equal(DAEMON_START.text, extractBalanced(worker, "const agent = await AirPrompterAgent.start({"));
  assert.ok(DAEMON_START.text.includes("apiKey:"));
  assert.ok(DAEMON_START.text.includes('mode: "resident"'));
  assert.ok(DAEMON_START.text.includes('policy: "unlock_required"'));

  assert.equal(POLICY_LINE.text, extractLine(worker, 'policy: "unlock_required"'));
  assert.ok(POLICY_LINE.text.includes('policy: "unlock_required"'));
  assert.equal(TELEMETRY_DAEMON.text, extractLine(unit, "ExecStart=/usr/local/bin/airprompter daemon"));

  assert.equal(AIRGAP_START.text, extractBalanced(airgap, "const agent = await AirPrompterAgent.start({"));
  assert.ok(AIRGAP_START.text.includes('mode: "offline"'));
  assert.ok(!AIRGAP_START.text.includes("apiKey"));

  assert.equal(ENQUEUE_CALL.text, 'onAction("enqueue", {ticketId,host:eu!.hostId})');
  assert.ok(metrics.includes(ENQUEUE_CALL.text));
});

test("the desk source has no inline style", () => {
  const root = join(repo, "apps/desk/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".css")) files.push(path);
    }
  };
  walk(root);
  const offenders = files.filter((path) => /style=|style=\{\{/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});
