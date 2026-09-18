#!/usr/bin/env node
/**
 * The desk's runtime path against AirPrompter itself: the public SDK syncs the release promoted to the configured
 * environment (`airprompter.config.json`; the Agent key from `AIRPROMPTER_AGENT_KEY` in the environment), verifies
 * it against the pinned root under `keys/`, and renders a slot — `support.reply` by default — for a customer whose
 * plan tier comes from this script's own customer table, the `customer_tier` variable the prompt declares as filled
 * by the runtime. Every claim is proved without showing the render (two sentinel tiers, one substitution apart; a
 * passed sentinel against the default; the fenced value found whole — `scripts/lib/scenarios.mjs`). It prints
 * generation, version, model, arm, what the runtime fills and what it still needs, and no prompt text — never the
 * key. It files nothing invented: no observation of a call that did not happen, only a heartbeat. Exit 1 when a
 * claim fails. This is what phase 3 turns into the desk API.
 *
 * @example
 * ```sh
 * set -a; . ~/.config/zudocs/dev.env; set +a      # AIRPROMPTER_AGENT_KEY (+ ids), never on argv
 * npm run dev:proof                                  # support.reply for customer cust-2002
 * npm run dev:proof -- support.escalate.handoff      # another slot that declares customer_tier
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { readConfig, repoRoot, secretFromEnv } from "./lib/config.mjs";
import { SCENARIOS, SENTINEL_CUSTOMERS, TIER_SENTINELS, VALUE_SENTINEL, customers, describeVariables, substitutionProof } from "./lib/scenarios.mjs";

const config = readConfig();
const apiKey = secretFromEnv("AIRPROMPTER_AGENT_KEY", "an Agent key from the app's Settings › Keys");
const tag = process.argv[2] ?? "support.reply";
const scenario = SCENARIOS[tag];
if (!scenario) {
  console.log(`no scenario for ${tag} — the slots are ${Object.keys(SCENARIOS).join(", ")} (scripts/lib/scenarios.mjs)`);
  process.exit(2);
}
const rootPath = join(repoRoot, "keys", `${config.hostedEnvironment}.root.jwk.json`);
if (!existsSync(rootPath)) {
  console.log(`${rootPath} is missing: the pinned root for the ${config.hostedEnvironment} deployment (keys/README.md)`);
  process.exit(1);
}

let failures = 0;
const fail = (message) => { failures += 1; console.log(`  ✗ ${message}`); };
const ok = (message) => console.log(`  ✓ ${message}`);

const events = [];
const ap = await AirPrompterAgent.start({
  organizationId: config.organizationId,
  agentId: config.agentId,
  target: config.environment,
  apiKey,
  baseUrl: config.baseUrl,
  stateDir: join(repoRoot, "state", "proof"),
  root: { pinned: JSON.parse(readFileSync(rootPath, "utf8")), hostedEnvironment: config.hostedEnvironment },
  sync: { mode: "resident", pollSeconds: 30, rootUrl: config.rootUrl },
  models: config.models,
  telemetry: { upload: false },
  variables: { customer_tier: { resolve: async ({ subject }) => customers.get(subject)?.tier, trust: "operator", timeoutMs: 500 } },
  logger: (event) => events.push(event),
});
try {
  const status = ap.status();
  console.log(`${config.environment} · generation ${ap.generation} · ${status.applyState} · release from ${status.source} · ${status.storageProtection} · lease until ${status.leaseExpiresAt ?? "n/a"} · policy ${status.applyPolicy.effective} (${status.applyPolicy.source})`);
  console.log(`variables: sources ${JSON.stringify(status.variables.sources)} · unsourced ${JSON.stringify(status.variables.unsourced)}`);

  const handle = ap.prompt(tag, { subject: scenario.subject });
  const declared = handle.variables();
  const needs = handle.needs(scenario.values);
  console.log(`${tag}: declared ${describeVariables(declared)} · needs after the call site: ${JSON.stringify(needs)}`);
  if (needs.length) fail(`the call site would still miss ${needs.join(", ")}`);
  const rendered = await handle.renderAsync(scenario.values);
  console.log(`rendered ${rendered.versionId} on ${rendered.model} · arm ${rendered.arm} · ${rendered.text.length} chars · inference ${JSON.stringify(rendered.inference ?? null)}`);
  if (rendered.text.includes("{{")) fail("a literal {{placeholder}} survived the render");
  for (const variable of declared) {
    if (variable.source === "runtime") {
      const [a, b] = await Promise.all(SENTINEL_CUSTOMERS.map((who) => ap.prompt(tag, { subject: who }).renderAsync(scenario.values)));
      const proof = substitutionProof(a.text, TIER_SENTINELS[0], b.text, TIER_SENTINELS[1]);
      if (proof.ok) ok(`${variable.name}: filled from the customer table at render time (${proof.occurrences} occurrence(s); ${scenario.subject} renders "${customers.get(scenario.subject).tier}")`);
      else fail(`${variable.name}: two customers' renders are not one substitution apart (${proof.reason}, ${proof.occurrences} occurrence(s))`);
    }
    if (variable.default !== undefined && !(variable.name in scenario.values)) {
      const passed = await handle.renderAsync({ ...scenario.values, [variable.name]: VALUE_SENTINEL });
      const proof = substitutionProof(passed.text, VALUE_SENTINEL, rendered.text, variable.default);
      if (proof.ok) ok(`${variable.name}: nobody passed it and the declared default "${variable.default}" rendered (${proof.occurrences} occurrence(s)); a passed value replaces exactly that`);
      else fail(`${variable.name}: the default "${variable.default}" is not what a passed value replaces (${proof.reason})`);
    }
    if (variable.trust === "end_user") {
      if (rendered.text.includes(`<${variable.name}>${scenario.values[variable.name]}</${variable.name}>`)) ok(`${variable.name}: the call site's value is in the render fenced as <${variable.name}>…</${variable.name}>`);
      else fail(`${variable.name} is declared end-user but the render does not carry the value fenced`);
    }
  }
  if (rendered.text.includes("## Success criteria")) ok("## Success criteria present (the judge reads it)");
  else if (scenario.criteria) fail("no ## Success criteria section, and this slot's judge rubric is the prompt's own");
  const checks = ap.checks(rendered, scenario.answer, { record: false });
  for (const result of checks.results) (result.verdict === "pass" ? ok : fail)(`check ${result.name} (${result.kind}) on the wire, run on a canned answer and not recorded: ${result.verdict}${result.reason ? ` — ${result.reason}` : ""}`);
  if (checks.results.length === 0) console.log("  no checks declared on the wire for this slot");
  await ap.heartbeatNow();
  const after = ap.status();
  if (after.heartbeat.lastAt) ok(`heartbeat sent at ${after.heartbeat.lastAt} (this instance reports models ${JSON.stringify(config.models)} and variables ${JSON.stringify(after.variables.sources)})`);
  else fail(`heartbeat refused: ${after.heartbeat.lastRefusal ?? "no reason recorded"}`);
  for (const event of events.filter((e) => ["variable_source_failed", "variable_source_trust_stricter", "refused", "sync_failed", "heartbeat_refused"].includes(String(e.event)))) console.log("log:", JSON.stringify(event));
} catch (error) {
  fail(`${error.name}: ${error.message}`);
} finally {
  await ap.stop();
}
console.log(failures === 0 ? "proof ok" : `proof failed: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
