#!/usr/bin/env node
/**
 * The vendored bundle is the CI agent's and nothing else: its sidecar names `ciAgentId` from `airprompter.config.json`
 * (never the support agent), and the verify document (from `airprompter verify … --json`, written by the workflow or
 * passed here) lists exactly the placeholder slot `ci.vendoring` — so the one plaintext bundle this public repository
 * commits can never be a Zudocs prompt. The rule CONTRIBUTING.md states; this makes it a check. Exit 1 on a breach.
 *
 * @example
 * ```sh
 * .bin/airprompter verify vendored/zudocs-ci.dev.apbundle --org … --agent … --environment dev --hosted-environment dev --root keys/dev.root.jwk.json --json > /tmp/verify.json
 * node scripts/check-vendored.mjs vendored/zudocs-ci.dev.apbundle /tmp/verify.json
 * ```
 */
import { readFileSync } from "node:fs";

export const CI_SLOTS = Object.freeze(["ci.vendoring"]);

/** Pure: the sidecar and the verify document against the config; a list of breaches, empty when clean. */
export function vendoredBreaches({ meta, verify, config }) {
  const breaches = [];
  if (!config.ciAgentId) breaches.push("airprompter.config.json names no ciAgentId");
  if (meta.kind !== "airprompter-bundle-meta") breaches.push(`the sidecar is not a bundle meta (${String(meta.kind)})`);
  if (meta.agentId !== config.ciAgentId) breaches.push(`the vendored bundle belongs to ${String(meta.agentId)}, not the CI agent ${String(config.ciAgentId)}`);
  if (meta.agentId === config.agentId) breaches.push("the vendored bundle is the support agent's — a Zudocs prompt would be committed");
  if (meta.organizationId !== config.organizationId) breaches.push("the vendored bundle is another organization's");
  const slots = verify?.manifest?.slots;
  const tags = !verify ? undefined : Array.isArray(slots) ? slots.map((s) => (typeof s === "string" ? s : s?.tag)) : typeof slots === "number" ? null : [];
  if (tags === undefined) {
    // No verify document (the local check): the sidecar's agent is the check; the workflow passes the document.
  } else if (tags === null) {
    // The verify document counts slots; the sidecar cannot name them. One slot, and the agent is the CI agent: enough.
    if (slots !== CI_SLOTS.length) breaches.push(`the manifest carries ${String(slots)} slot(s); the CI agent has ${CI_SLOTS.length}`);
  } else {
    const foreign = tags.filter((t) => !CI_SLOTS.includes(t));
    if (foreign.length) breaches.push(`the manifest carries slots outside the CI agent's: ${foreign.join(", ")}`);
    if (tags.length !== CI_SLOTS.length) breaches.push(`the manifest carries ${tags.length} slot(s); expected ${CI_SLOTS.join(", ")}`);
  }
  if (verify && verify.ok !== true) breaches.push(`the verify document is not ok (${String(verify.step)}: ${String(verify.reason)})`);
  return breaches;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const [bundle, verifyPath] = process.argv.slice(2);
  if (!bundle) { console.log("usage: check-vendored.mjs <bundle.apbundle> [verify.json]"); process.exit(2); }
  const meta = JSON.parse(readFileSync(`${bundle}.meta.json`, "utf8"));
  const verify = verifyPath ? JSON.parse(readFileSync(verifyPath, "utf8").trim().split("\n").pop()) : null;
  const config = JSON.parse(readFileSync(new URL("../airprompter.config.json", import.meta.url), "utf8"));
  const breaches = vendoredBreaches({ meta, verify, config });
  if (breaches.length) { for (const b of breaches) console.log(`✗ ${b}`); process.exit(1); }
  console.log(`✓ ${bundle}: the CI agent ${meta.agentId}, generation ${meta.generation}, ${verify ? `${String(verify.manifest?.slots)} slot(s), verified` : "sidecar only"}`);
}
