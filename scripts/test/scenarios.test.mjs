import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIOS, SENTINEL_CUSTOMERS, TIER_SENTINELS, VALUE_SENTINEL, checkNameProblems, customers, describeVariables, substitutionProof } from "../lib/scenarios.mjs";

test("a substitution proof passes only when the texts are one value apart, however often it occurs", () => {
  assert.deepEqual(substitutionProof("plan: A. For A customers.", "A", "plan: B. For B customers.", "B"), { ok: true, occurrences: 2 }, "a variable used twice");
  assert.deepEqual(substitutionProof("the A-plan", "A", "the B-plan", "B"), { ok: true, occurrences: 1 }, "adjacent to word characters");
  assert.deepEqual(substitutionProof("tone: friendly", "zudocs-value-sentinel", "tone: friendly", "friendly"), { ok: false, reason: "absent", occurrences: 0 }, "the sentinel never rendered: the value was not this variable's");
  assert.deepEqual(substitutionProof("plan: A. Hello.", "A", "plan: B. Goodbye.", "B"), { ok: false, reason: "differs_elsewhere", occurrences: 1 });
  assert.deepEqual(substitutionProof("plan: A. For A.", "A", "plan: B. For A.", "B"), { ok: false, reason: "differs_elsewhere", occurrences: 2 }, "one occurrence swapped, one not");
  assert.deepEqual(substitutionProof("x", "x", "x", "x"), { ok: true, occurrences: 1 }, "a default equal to the passed value is still one substitution");
  assert.deepEqual(substitutionProof("tone: S", "S", "tone: $&", "$&"), { ok: true, occurrences: 1 }, "a replacement is text, never a pattern");
  assert.deepEqual(substitutionProof("tone: S", "S", "tone: SS", "SS"), { ok: true, occurrences: 1 }, "the value may contain the sentinel");
  assert.throws(() => substitutionProof("a", "", "a", "b"), /non-empty value/);
});

test("the sentinels occur in no scenario text, so a proof can never pass on the prompt's own words", () => {
  const texts = Object.values(SCENARIOS).flatMap((s) => [...Object.values(s.values), s.answer]);
  for (const sentinel of [...TIER_SENTINELS, VALUE_SENTINEL]) for (const text of texts) assert.ok(!text.includes(sentinel), `${sentinel} must not occur in a scenario text`);
  assert.deepEqual(SENTINEL_CUSTOMERS.map((who) => customers.get(who).tier), TIER_SENTINELS);
  assert.notEqual(TIER_SENTINELS[0], TIER_SENTINELS[1]);
});

test("every slot the desk knows has a scenario whose values match its declared variables' shape", () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), ["support.escalate.handoff", "support.escalate.summary", "support.reply", "support.triage"]);
  assert.deepEqual(Object.keys(SCENARIOS["support.escalate.handoff"].values), ["summary"], "step 2 takes step 1's answer");
  assert.equal(SCENARIOS["support.reply"].criteria, true);
  assert.ok(JSON.parse(SCENARIOS["support.triage"].answer).category, "the canned triage answer is the JSON the checks expect");
});

test("describeVariables writes the CLI's marker grammar", () => {
  assert.equal(describeVariables([
    { name: "tone", required: false, trust: "operator", default: "friendly" },
    { name: "customer_tier", required: true, trust: "operator", source: "runtime" },
    { name: "ticket", required: true, trust: "end_user" },
  ]), "tone=friendly, customer_tier!~, ticket?");
  assert.equal(describeVariables([{ name: "notes", required: true, trust: "end_user", source: "runtime" }]), "notes?~");
});

test("checkNameProblems is order-blind and names both sides when they differ", () => {
  assert.deepEqual(checkNameProblems(["b", "a"], ["a", "b"]), []);
  assert.deepEqual(checkNameProblems([], ["a"]), ['declared [], the scenario expects ["a"]']);
  for (const [tag, scenario] of Object.entries(SCENARIOS)) assert.ok(Array.isArray(scenario.checks) && scenario.checks.length > 0, `${tag} names its checks`);
});
