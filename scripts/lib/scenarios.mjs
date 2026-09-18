/**
 * What the smoke and the proof render each slot with, and how a claim about a render is proved without printing
 * the render: the desk's customer table in miniature (two customers carry sentinel tiers that occur nowhere in
 * any prompt), a scenario per slot (the call site's values and a canned answer of the shape a right output has),
 * and `substitutionProof` — the check that two renders are the same text with one value swapped for another,
 * everywhere it occurs and nowhere else. Sentinels make it exact: a tier that is also a word in the prompt
 * ("trial") could not be told apart from the prompt's own text.
 *
 * @example
 * ```js
 * const a = await ap.prompt(tag, { subject: SENTINEL_CUSTOMERS[0] }).renderAsync(values);
 * const b = await ap.prompt(tag, { subject: SENTINEL_CUSTOMERS[1] }).renderAsync(values);
 * substitutionProof(a.text, TIER_SENTINELS[0], b.text, TIER_SENTINELS[1]);   // { ok: true, occurrences: 1 } or { ok: false, reason }
 * ```
 */

/** The application's own record of who is on which plan; the last two rows exist for the proofs. */
export const TIER_SENTINELS = ["zudocs-tier-alpha", "zudocs-tier-beta"];
export const SENTINEL_CUSTOMERS = ["proof-a", "proof-b"];
export const customers = new Map([
  ["cust-1001", { name: "Acme Docs", tier: "team" }],
  ["cust-2002", { name: "Nimbus Labs", tier: "trial" }],
  ["cust-3003", { name: "Orbital Bank", tier: "enterprise" }],
  [SENTINEL_CUSTOMERS[0], { name: "Proof A", tier: TIER_SENTINELS[0] }],
  [SENTINEL_CUSTOMERS[1], { name: "Proof B", tier: TIER_SENTINELS[1] }],
]);

/** A value no prompt contains, passed for an optional variable to prove its default was what rendered. */
export const VALUE_SENTINEL = "zudocs-value-sentinel";

const TICKET = "Search still returns a page we deleted last week. Clicking it gives a 404.";
const SUMMARY = "Symptom: a deleted page still appears in search and 404s when opened.\nWhere: search; page not named.\nSince: last week.\nTried: not stated.\nImpact: the team sees stale results.\nUnknown: the page URL; whether other deleted pages show too.";

/**
 * Per slot: the call site's values, the customer the render is for, whether it must carry success criteria, the
 * output checks the release declares for it, and a canned answer of the shape a right output has.
 */
export const SCENARIOS = {
  "support.triage": { values: { ticket: TICKET }, subject: "cust-1001", checks: ["category", "priority", "shape"], answer: '{"category":"search","priority":"normal","summary":"A deleted page still appears in search results and returns 404."}' },
  "support.reply": { values: { ticket: TICKET }, subject: "cust-2002", criteria: true, checks: ["no-guarantee", "signed", "under-300-tokens"], answer: "Thanks for flagging this — a deleted page lingering in search is our index running behind. I have queued a re-index of your space; results usually catch up within the hour. Your trial includes full search, so nothing to change on your side. If it is still there tomorrow, send me the page URL and I will look directly.\n\nThe Zudocs team" },
  "support.escalate.summary": { values: { ticket: TICKET }, subject: "cust-1001", checks: ["has-symptom", "under-400-tokens"], answer: SUMMARY },
  "support.escalate.handoff": { values: { summary: SUMMARY }, subject: "cust-3003", checks: ["has-severity"], answer: "Title: Deleted page still in search (search)\nSeverity: S3 — a defect with a workaround (open the page from the tree)\nPlan: enterprise; copy the account manager, respond within four hours\nFacts:\n- deleted page still listed\n- opening it gives 404\n- since last week\nAsk: check the index for tombstoned pages; ask the customer for the page URL." },
};

/** The one-line summary of a declaration in the CLI's marker grammar (`tone=friendly, customer_tier!~, ticket?`). */
export function describeVariables(variables) {
  return variables.map((v) => `${v.name}${v.required && v.trust !== "end_user" ? "!" : ""}${v.trust === "end_user" ? "?" : ""}${v.source === "runtime" ? "~" : ""}${v.default !== undefined ? `=${v.default}` : ""}`).join(", ");
}

/**
 * `b` is `a` with every `valueA` replaced by `valueB` and nothing else changed, and `valueA` occurs at least once.
 * Reasons: `absent` (valueA is not in a), `differs_elsewhere` (the texts differ beyond the substitution).
 * Nothing of either text is returned — counts only.
 */
export function substitutionProof(a, valueA, b, valueB) {
  if (typeof valueA !== "string" || valueA === "") throw new Error("a substitution proof needs a non-empty value to look for");
  const parts = a.split(valueA);
  const occurrences = parts.length - 1;
  if (occurrences === 0) return { ok: false, reason: "absent", occurrences };
  // split/join, not replaceAll: a replacement string would read `$&` and friends as patterns.
  if (parts.join(valueB) !== b) return { ok: false, reason: "differs_elsewhere", occurrences };
  return { ok: true, occurrences };
}

/** The names of the checks a slot declares against the names a scenario expects; empty when they agree. */
export function checkNameProblems(declared, expected) {
  const have = [...declared].sort();
  const want = [...expected].sort();
  if (JSON.stringify(have) === JSON.stringify(want)) return [];
  return [`declared ${JSON.stringify(have)}, the scenario expects ${JSON.stringify(want)}`];
}
