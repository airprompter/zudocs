#!/usr/bin/env node
/**
 * The desk's runtime path against AirPrompter itself: the public SDK syncs the release promoted to the configured
 * environment (`airprompter.config.json`; the Agent key from `AIRPROMPTER_AGENT_KEY` in the environment), verifies
 * it against the pinned root under `keys/`, and renders `support.reply` for a customer whose plan tier comes from
 * this script's own customer table — the `customer_tier` variable the prompt declares as filled by the runtime.
 * Prints generation, version, model, arm, what the runtime fills and what it still needs; never the key, never a
 * whole prompt. This is what phase 3 turns into the desk API.
 *
 * @example
 * ```sh
 * set -a; . ~/.config/zudocs/dev.env; set +a      # AIRPROMPTER_AGENT_KEY (+ ids), never on argv
 * npm run dev:proof                                  # renders support.reply for customer cust-2002
 * npm run dev:proof -- cust-3003 support.escalate.handoff
 * ```
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { readConfig, repoRoot, secretFromEnv } from "./lib/config.mjs";

const config = readConfig();
const apiKey = secretFromEnv("AIRPROMPTER_AGENT_KEY", "an Agent key from the app's Settings › Keys");
const [subject = "cust-2002", tag = "support.reply"] = process.argv.slice(2);

/** The desk's customer table, in miniature: the tier is looked up at render time, never passed by the call site. */
const customers = new Map([
  ["cust-1001", { tier: "team" }],
  ["cust-2002", { tier: "trial" }],
  ["cust-3003", { tier: "enterprise" }],
]);
const TICKET = "Since this morning our public docs site returns 502 for every page. Nothing changed on our side.";
const SUMMARY = "Symptom: the public docs site answers 502 on every page.\nWhere: publishing; domain not named.\nSince: this morning.\nTried: not stated.\nImpact: every reader of the public site.\nUnknown: the custom domain; whether the space was republished today.";

const events = [];
const ap = await AirPrompterAgent.start({
  organizationId: config.organizationId,
  agentId: config.agentId,
  target: config.environment,
  apiKey,
  baseUrl: config.baseUrl,
  stateDir: join(repoRoot, "state", "proof"),
  root: { pinned: JSON.parse(readFileSync(join(repoRoot, "keys", `${config.hostedEnvironment}.root.jwk.json`), "utf8")), hostedEnvironment: config.hostedEnvironment },
  sync: { mode: "resident", pollSeconds: 30, rootUrl: config.rootUrl },
  models: config.models,
  telemetry: { upload: true },
  variables: { customer_tier: { resolve: async ({ subject: who }) => customers.get(who)?.tier, trust: "operator", timeoutMs: 500 } },
  logger: (event) => events.push(event),
});
const status = ap.status();
console.log(`${config.environment} · generation ${ap.generation} · ${status.applyState} · release from ${status.source} · ${status.storageProtection} · lease until ${status.leaseExpiresAt ?? "n/a"} · policy ${status.applyPolicy.effective} (${status.applyPolicy.source})`);
console.log(`variables: sources ${JSON.stringify(status.variables?.sources ?? [])} · unsourced ${JSON.stringify(status.variables?.unsourced ?? [])}`);

const handle = ap.prompt(tag, { subject });
const values = tag === "support.escalate.handoff" ? { summary: SUMMARY } : { ticket: TICKET };
console.log(`${tag}: declared ${handle.variables().map((v) => `${v.name}${v.required ? "!" : ""}${v.trust === "end_user" ? "?" : ""}${v.source === "runtime" ? "~" : ""}${v.default ? `=${v.default}` : ""}`).join(", ")} · needs after the call site: ${JSON.stringify(handle.needs(values))}`);
const rendered = await handle.renderAsync(values);
const tier = customers.get(subject)?.tier ?? "(unknown customer)";
const lines = rendered.text.split("\n");
console.log(`rendered ${rendered.versionId} on ${rendered.model} · arm ${rendered.arm} · ${rendered.text.length} chars · inference ${JSON.stringify(rendered.inference ?? null)}`);
console.log(`  customer ${subject} → tier "${tier}": ${lines.find((l) => l.includes(tier))?.trim().slice(0, 90) ?? "NOT FILLED"}`);
for (const variable of handle.variables()) {
  if (variable.default !== undefined && !(variable.name in values)) console.log(`  ${variable.name} default "${variable.default}": ${lines.find((l) => l.includes(variable.default))?.trim().slice(0, 60) ?? "NOT RENDERED"}`);
  if (variable.trust === "end_user") console.log(`  ${variable.name}: ${rendered.text.includes(`<${variable.name}>`) ? "fenced as end-user text" : "NOT FENCED"}`);
}
if (rendered.text.includes("## Success criteria")) console.log("  ## Success criteria present (the judge reads it)");
// One content-free observation with a canned answer, so the app's counters reach the board without a model.
const observed = await ap.observe(rendered, () => ({ text: "The Zudocs team", usage: { input_tokens: 400, output_tokens: 40 } }));
console.log(`observed a call (${observed.usage.output_tokens} output tokens) · checks on the wire: ${ap.checks(rendered, "Thank you.\n\nThe Zudocs team", { record: false }).results.map((r) => `${r.name}=${r.verdict}`).join(", ")}`);
await ap.heartbeatNow();
const flushed = await ap.uploadNow();
console.log(`heartbeat sent · upload ${JSON.stringify(flushed)}`);
for (const event of events.filter((e) => ["variable_source_failed", "variable_source_trust_stricter", "refused", "sync_failed"].includes(String(e.event)))) console.log("log:", JSON.stringify(event));
await ap.stop();
