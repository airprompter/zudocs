#!/usr/bin/env node
/**
 * The desk's runtime path against AirPrompter itself: the public SDK syncs the release promoted to the configured
 * environment (`airprompter.config.json`; the Agent key from `AIRPROMPTER_AGENT_KEY` in the environment), verifies
 * it against the pinned root under `keys/`, and renders `support.reply` for a customer whose plan tier comes from
 * this script's own customer table — the `customer_tier` variable the prompt declares as filled by the runtime.
 * Every claim is proved by comparing two renders (two customers; a passed tone against the default) or by finding
 * the exact fenced value; it prints generation, version, model, arm, what the runtime fills and what it still
 * needs, and no prompt text — never the key. It files nothing invented: no observation of a call that did not
 * happen, only the heartbeat. Exit 1 when a claim fails. This is what phase 3 turns into the desk API.
 *
 * @example
 * ```sh
 * set -a; . ~/.config/zudocs/dev.env; set +a      # AIRPROMPTER_AGENT_KEY (+ ids), never on argv
 * npm run dev:proof                                  # renders support.reply for customers cust-2002 and cust-3003
 * npm run dev:proof -- support.escalate.handoff      # another slot that declares customer_tier
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { readConfig, repoRoot, secretFromEnv } from "./lib/config.mjs";

const config = readConfig();
const apiKey = secretFromEnv("AIRPROMPTER_AGENT_KEY", "an Agent key from the app's Settings › Keys");
const tag = process.argv[2] ?? "support.reply";
const rootPath = join(repoRoot, "keys", `${config.hostedEnvironment}.root.jwk.json`);
if (!existsSync(rootPath)) {
  console.log(`${rootPath} is missing: the pinned root for the ${config.hostedEnvironment} deployment (keys/README.md)`);
  process.exit(1);
}

/** The desk's customer table, in miniature: the tier is looked up at render time, never passed by the call site. */
const customers = new Map([
  ["cust-1001", { tier: "team" }],
  ["cust-2002", { tier: "trial" }],
  ["cust-3003", { tier: "enterprise" }],
]);
const [subject, other] = ["cust-2002", "cust-3003"];
const TICKET = "Since this morning our public docs site returns 502 for every page. Nothing changed on our side.";
const SUMMARY = "Symptom: the public docs site answers 502 on every page.\nWhere: publishing; domain not named.\nSince: this morning.\nTried: not stated.\nImpact: every reader of the public site.\nUnknown: the custom domain; whether the space was republished today.";

let failures = 0;
const fail = (message) => { failures += 1; console.log(`  ✗ ${message}`); };
const ok = (message) => console.log(`  ✓ ${message}`);
/**
 * The one span where two texts differ, widened to whole words so "friendly" against "formal" is not "riendly"
 * against "ormal": [what a has, what b has]; null when they are equal.
 */
function differingSpan(a, b) {
  if (a === b) return null;
  const word = /[A-Za-z0-9_-]/;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  while (start > 0 && word.test(a[start - 1])) start -= 1;
  while (endA < a.length && endB < b.length && word.test(a[endA]) && a[endA] === b[endB]) { endA += 1; endB += 1; }
  return [a.slice(start, endA), b.slice(start, endB)];
}

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
  variables: { customer_tier: { resolve: async ({ subject: who }) => customers.get(who)?.tier, trust: "operator", timeoutMs: 500 } },
  logger: (event) => events.push(event),
});
try {
  const status = ap.status();
  console.log(`${config.environment} · generation ${ap.generation} · ${status.applyState} · release from ${status.source} · ${status.storageProtection} · lease until ${status.leaseExpiresAt ?? "n/a"} · policy ${status.applyPolicy.effective} (${status.applyPolicy.source})`);
  console.log(`variables: sources ${JSON.stringify(status.variables.sources)} · unsourced ${JSON.stringify(status.variables.unsourced)}`);

  const handle = ap.prompt(tag, { subject });
  const declared = handle.variables();
  const values = declared.some((v) => v.name === "summary") ? { summary: SUMMARY } : { ticket: TICKET };
  const needs = handle.needs(values);
  console.log(`${tag}: declared ${declared.map((v) => `${v.name}${v.required ? "!" : ""}${v.trust === "end_user" ? "?" : ""}${v.source === "runtime" ? "~" : ""}${v.default ? `=${v.default}` : ""}`).join(", ")} · needs after the call site: ${JSON.stringify(needs)}`);
  if (needs.length) fail(`the call site would still miss ${needs.join(", ")}`);
  const rendered = await handle.renderAsync(values);
  console.log(`rendered ${rendered.versionId} on ${rendered.model} · arm ${rendered.arm} · ${rendered.text.length} chars · inference ${JSON.stringify(rendered.inference ?? null)}`);
  if (rendered.text.includes("{{")) fail("a literal {{placeholder}} survived the render");
  for (const variable of declared) {
    if (variable.source === "runtime") {
      const otherRender = await ap.prompt(tag, { subject: other }).renderAsync(values);
      const span = differingSpan(rendered.text, otherRender.text);
      const tiers = [customers.get(subject).tier, customers.get(other).tier];
      if (span && span[0] === tiers[0] && span[1] === tiers[1]) ok(`${variable.name}: filled from the customer table — ${subject} renders "${tiers[0]}", ${other} renders "${tiers[1]}", nothing else differs`);
      else fail(`${variable.name}: the renders for ${subject} and ${other} differ by ${JSON.stringify(span)}, expected ${JSON.stringify(tiers)}`);
    }
    if (variable.default !== undefined && !(variable.name in values)) {
      const passed = await handle.renderAsync({ ...values, [variable.name]: "formal" });
      const span = differingSpan(rendered.text, passed.text);
      if (span && span[0] === variable.default && span[1] === "formal") ok(`${variable.name}: nobody passed it and the declared default "${variable.default}" rendered; passing "formal" replaces exactly that`);
      else fail(`${variable.name}: expected the default "${variable.default}" to be the one difference, got ${JSON.stringify(span)}`);
    }
    if (variable.trust === "end_user") {
      if (rendered.text.includes(`<${variable.name}>${values[variable.name]}</${variable.name}>`)) ok(`${variable.name}: the call site's value is in the render fenced as <${variable.name}>…</${variable.name}>`);
      else fail(`${variable.name} is declared end-user but the render does not carry the value fenced`);
    }
  }
  if (rendered.text.includes("## Success criteria")) ok("## Success criteria present (the judge reads it)");
  const checks = ap.checks(rendered, "Thank you for writing in.\n\nThe Zudocs team", { record: false });
  console.log(`  checks on the wire, run on a canned answer and not recorded: ${checks.results.map((r) => `${r.name}=${r.verdict}`).join(", ") || "none declared"}`);
  await ap.heartbeatNow();
  const after = ap.status();
  console.log(`heartbeat sent at ${after.heartbeat.lastAt} (this instance reports models ${JSON.stringify(config.models)} and variables ${JSON.stringify(after.variables.sources)})`);
  for (const event of events.filter((e) => ["variable_source_failed", "variable_source_trust_stricter", "refused", "sync_failed", "heartbeat_refused"].includes(String(e.event)))) console.log("log:", JSON.stringify(event));
} catch (error) {
  fail(`${error.name}: ${error.message}`);
} finally {
  await ap.stop();
}
console.log(failures === 0 ? "proof ok" : `proof failed: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
