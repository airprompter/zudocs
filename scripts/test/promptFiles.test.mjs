import assert from "node:assert/strict";
import { test } from "node:test";
import { fileFor, parsePromptFile, parseVariableMarker, pathForTag, variableMarker } from "../lib/promptFiles.mjs";

test("a tag becomes the path the CLI derives the tag from", () => {
  assert.equal(pathForTag("support.triage"), "support/triage.md");
  assert.equal(pathForTag("support.escalate.summary"), "support/escalate/summary.md");
  assert.equal(pathForTag("tier-note"), "tier-note.md");
  assert.throws(() => pathForTag("Support.Triage"), /not a slot tag/, "the grammar is lower-case");
  assert.throws(() => pathForTag("support..triage"), /not a slot tag/, "no doubled separators");
});

test("every declaration renders in the CLI's marker order and reads back the same", () => {
  const cases = [
    [{ name: "ticket", required: true, trust: "end_user" }, "ticket?"],
    [{ name: "summary", required: true, trust: "operator" }, "summary!"],
    [{ name: "tone", required: false, trust: "operator" }, "tone"],
    [{ name: "tone", required: false, trust: "operator", default: "friendly" }, "tone=friendly"],
    [{ name: "customer_tier", required: true, trust: "operator", source: "runtime" }, "customer_tier!~"],
    [{ name: "customer_tier", required: false, trust: "operator", source: "runtime" }, "customer_tier~"],
    [{ name: "region", required: false, trust: "operator", source: "runtime", default: "eu" }, "region~=eu"],
    [{ name: "notes", required: true, trust: "end_user", source: "runtime" }, "notes?~"],
  ];
  for (const [declaration, marker] of cases) {
    assert.equal(variableMarker(declaration), marker);
    assert.deepEqual(parseVariableMarker(marker), declaration, `${marker} reads back`);
  }
  // `source: "caller"` is the protocol's "not said": the grammar has no marker for it and the CLI reads none.
  assert.equal(variableMarker({ name: "ticket", required: true, trust: "end_user", source: "caller" }), "ticket?");
});

test("what the grammar cannot carry is refused, never mangled", () => {
  assert.throws(() => variableMarker({ name: "tone", required: false, trust: "operator", default: "warm, brief" }), /comma/, "the line is comma-separated");
  assert.throws(() => variableMarker({ name: "tone", required: false, trust: "operator", default: "one\ntwo" }), /line break/);
  assert.throws(() => variableMarker({ name: "tone", required: false, trust: "operator", default: "" }), /never empty/);
  assert.throws(() => variableMarker({ name: "tone", required: false, trust: "operator", default: " warm" }), /trims a default/);
  // A default may hold "=": the CLI splits on the first one only.
  assert.equal(variableMarker({ name: "sign", required: false, trust: "operator", default: "a=b" }), "sign=a=b");
  assert.deepEqual(parseVariableMarker("sign=a=b"), { name: "sign", required: false, trust: "operator", default: "a=b" });
  assert.throws(() => variableMarker({ name: "ticket", required: true, trust: "operator", default: "x" }), /optional operator/);
  assert.throws(() => variableMarker({ name: "ticket", required: false, trust: "end_user", default: "x" }), /optional operator/);
  assert.throws(() => variableMarker({ name: "bad name", required: false, trust: "operator" }), /name refused/);
  assert.throws(() => parseVariableMarker("name~!"), /markers go/, "the CLI's order, not a variable called name~");
  assert.throws(() => parseVariableMarker("ticket?=x"), /optional operator/);
});

test("a slot file round-trips: front matter the CLI reads, the two JSON lines, the text untouched", () => {
  const slot = {
    tag: "support.reply",
    model: "openai.gpt-5-6-luna",
    versionId: "rev-2",
    variables: [
      { name: "tone", required: false, trust: "operator", default: "friendly" },
      { name: "customer_tier", required: true, trust: "operator", source: "runtime" },
      { name: "ticket", required: true, trust: "end_user" },
    ],
    checks: [{ kind: "must_match", name: "signed", pattern: "The Zudocs team" }, { kind: "length", name: "cap", maxTokens: 300 }],
    inference: { maxOutputTokens: 600, reasoningEffort: "low" },
    text: "Tone: {{tone}}. Plan: {{customer_tier}}.\n\n{{ticket}}\n\n## Success criteria\n- Signed.\n",
  };
  const file = fileFor(slot);
  assert.equal(file.path, "support/reply.md");
  const lines = file.text.split("\n");
  assert.equal(lines[0], "---");
  assert.deepEqual(lines.slice(1, 5), ["tag: support.reply", "model: openai.gpt-5-6-luna", "version: rev-2", "variables: tone=friendly, customer_tier!~, ticket?"]);
  assert.equal(lines[7], "---");
  assert.ok(file.text.endsWith("- Signed.\n"), "one trailing newline, no more");
  const parsed = parsePromptFile(file.text);
  assert.equal(parsed.meta.tag, "support.reply");
  assert.equal(parsed.meta.model, slot.model);
  assert.equal(parsed.meta.version, "rev-2");
  assert.deepEqual(parsed.variables, slot.variables);
  assert.deepEqual(parsed.checks, slot.checks);
  assert.deepEqual(parsed.inference, slot.inference);
  assert.equal(parsed.body, slot.text.trim());
});

test("a slot with no checks and no settings writes neither line; a file with neither parses to empty", () => {
  const file = fileFor({ tag: "support.triage", model: "amazon.nova-micro", versionId: "rev-1", variables: [{ name: "ticket", required: true, trust: "end_user" }], text: "{{ticket}}" });
  assert.ok(!file.text.includes("checks:"));
  assert.ok(!file.text.includes("inference:"));
  const parsed = parsePromptFile(file.text);
  assert.deepEqual(parsed.checks, []);
  assert.equal(parsed.inference, null);
  assert.deepEqual(parsePromptFile("---\nmodel: m\n---\nhello\n").variables, [], "no variables line: none declared here (the CLI scans the text)");
});

test("text that would be misread is refused: empty, or opening with a front-matter fence", () => {
  const base = { tag: "a", model: "m", versionId: "rev-1", variables: [] };
  assert.throws(() => fileFor({ ...base, text: "  \n" }), /empty/);
  assert.throws(() => fileFor({ ...base, text: "---\nnot front matter\n" }), /front matter/);
  assert.throws(() => parsePromptFile("no fence here"), /no front matter/);
  assert.throws(() => parsePromptFile("---\nchecks: {}\n---\nx"), /JSON array/);
});
