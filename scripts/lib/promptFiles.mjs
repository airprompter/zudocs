/**
 * The shape of the local prompt registry under `./prompts` — the files `airprompter dev` serves — as pure functions
 * shared by the seed (writes them from AirPrompter) and the smoke (reads them back).
 *
 * A slot is one file: its tag is the path (`support/triage.md` → `support.triage`), its front matter carries the
 * grammar the CLI's `dev` command reads (`model:`, `variables:`, `version:`) plus two lines the CLI ignores and the
 * smoke uses: `checks:` (the slot's declared output checks as one JSON array) and `inference:` (the version's model
 * settings as one JSON object). The variable grammar is the CLI's: `name!` required, `name?` end-user text (fenced
 * at render time), `name~` filled by the application's own source, `name=default` an optional operator variable
 * with a default — markers in that order (`name!~`, `name~=default`), and a default never holds a comma because the
 * line is comma-separated.
 *
 * @example
 * ```js
 * import { fileFor, parsePromptFile, pathForTag } from "./lib/promptFiles.mjs";
 * const { path, text } = fileFor({ tag: "support.reply", model: "openai.gpt-5-6-luna", versionId: "rev-2",
 *   variables: [{ name: "tone", required: false, trust: "operator", default: "friendly" }], text: "Tone: {{tone}}" });
 * const parsed = parsePromptFile(text);   // { meta: { tag, model, version, checks, inference }, variables, body }
 * ```
 */

/** `support.escalate.summary` → `support/escalate/summary.md` (the CLI derives the tag from this path). */
export function pathForTag(tag) {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(tag)) throw new Error(`not a slot tag: ${tag}`);
  return `${tag.split(".").join("/")}.md`;
}

/** One declared variable in the CLI's front-matter grammar; refuses what the grammar cannot carry. */
export function variableMarker(variable) {
  const { name, required, trust, source } = variable;
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error(`variable name refused: ${JSON.stringify(name)}`);
  const endUser = trust === "end_user";
  let marker = name;
  if (endUser) marker += "?";
  else if (required) marker += "!";
  if (source === "runtime") marker += "~";
  if (variable.default !== undefined) {
    if (required || endUser) throw new Error(`variable ${name}: a default belongs to an optional operator variable only`);
    if (variable.default === "") throw new Error(`variable ${name}: a default is never empty`);
    if (variable.default.includes(",") || variable.default.includes("\n")) throw new Error(`variable ${name}: the dev grammar cannot carry a default with a comma or a line break (change the default in AirPrompter, or fill it at the call site)`);
    if (variable.default !== variable.default.trim()) throw new Error(`variable ${name}: the dev grammar trims a default, so one with leading or trailing whitespace cannot round-trip`);
    marker += `=${variable.default}`;
  }
  return marker;
}

/** The inverse: `name!~=default` → the declaration (mirrors `parseVariables` in the CLI). */
export function parseVariableMarker(raw) {
  const eq = raw.indexOf("=");
  const head = eq === -1 ? raw.trim() : raw.slice(0, eq).trim();
  const defaultValue = eq === -1 ? undefined : raw.slice(eq + 1).trim();
  const runtime = head.endsWith("~");
  const marker = head.replace(/~$/, "");
  const required = marker.endsWith("!");
  const endUser = marker.endsWith("?");
  const name = marker.replace(/[!?]$/, "");
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error(`variable ${JSON.stringify(raw)}: markers go name!, name?, name~ or name!~ / name?~, then =default`);
  if (defaultValue !== undefined && (required || endUser)) throw new Error(`variable ${name}: a default belongs to an optional operator variable only`);
  if (defaultValue === "") throw new Error(`variable ${name}: a default is never empty`);
  return {
    name,
    required: required || endUser,
    trust: endUser ? "end_user" : "operator",
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(runtime ? { source: "runtime" } : {}),
  };
}

/** The whole file for one slot: front matter, a blank line, the version's text (unchanged, trailing newline). */
export function fileFor(slot) {
  const lines = [`tag: ${slot.tag}`, `model: ${slot.model}`, `version: ${slot.versionId}`, `variables: ${slot.variables.map(variableMarker).join(", ")}`];
  if (slot.checks?.length) lines.push(`checks: ${JSON.stringify(slot.checks)}`);
  if (slot.inference && Object.keys(slot.inference).length) lines.push(`inference: ${JSON.stringify(slot.inference)}`);
  for (const line of lines) if (line.includes("\n")) throw new Error(`front matter is one line per key: ${line.slice(0, 40)}…`);
  const body = slot.text.replace(/\r\n/g, "\n").trim();
  if (!body) throw new Error(`${slot.tag}: the version's text is empty`);
  if (body.startsWith("---")) throw new Error(`${slot.tag}: the text starts with --- and would be read as front matter`);
  return { path: pathForTag(slot.tag), text: `---\n${lines.join("\n")}\n---\n${body}\n` };
}

/** Reads a prompt file back: the CLI's keys, the two JSON lines, the declarations, the text. */
export function parsePromptFile(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!front) throw new Error("no front matter block");
  const meta = {};
  for (const line of front[1].split("\n")) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  const variables = meta.variables === undefined || meta.variables === "" ? [] : meta.variables.split(",").map((v) => v.trim()).filter(Boolean).map(parseVariableMarker);
  const checks = meta.checks ? JSON.parse(meta.checks) : [];
  const inference = meta.inference ? JSON.parse(meta.inference) : null;
  if (!Array.isArray(checks)) throw new Error("checks: must be a JSON array");
  return { meta, variables, checks, inference, body: text.slice(front[0].length).trim() };
}
