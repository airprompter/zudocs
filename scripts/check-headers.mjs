#!/usr/bin/env node
/**
 * Every source file opens with a header that says what the file is for and shows how to use it.
 *
 * The rule (CONTRIBUTING.md › "File headers"): a TypeScript / JavaScript file starts with a `/** … *\/` block (or a
 * run of `//` lines), a shell script (by extension or shebang), a systemd unit or a Python file with a run of `#`
 * lines / a module docstring after the shebang;
 * the header explains the file in a sentence or more and carries one small usage example — a `@example` fenced
 * block, a `$ command` line, or an indented call. Tests and vendored code are exempt. Plain Node, no dependencies:
 *
 *   $ node scripts/check-headers.mjs            # lists every file that misses the rule; exit 1 when any does
 *   $ node scripts/check-headers.mjs --list     # also lists the files that pass
 */

import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const ROOTS = ["infra/bin", "infra/lib", "apps", "services", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", "cdk.out", ".airprompter-dev", "vendor"]);
const EXT = new Set([".ts", ".mjs", ".js", ".py", ".sh"]);
const list = process.argv.includes("--list");

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
      continue;
    }
    const ext = extname(entry);
    // A script with no extension counts when it starts with a shebang (the eu-west host's helpers); so does a systemd unit.
    const shebang = ext === "" && readFileSync(path, "utf8").startsWith("#!");
    if (!(EXT.has(ext) || shebang || ext === ".service") || entry.endsWith(".d.ts")) continue;
    const rel = relative(root, path).split(sep).join("/");
    if (/(^|\/)(test|tests)\//.test(rel) || /\.test\.(ts|mjs|js)$/.test(entry) || /^test_.*\.py$/.test(entry) || entry === "conftest.py") continue;
    yield path;
  }
}

/** The header: a leading docstring (Python), a `#` run (shell), or a leading block / line-comment run (JS/TS), after any shebang. */
function headerOf(source, ext) {
  let text = source.replace(/^﻿/, "");
  if (text.startsWith("#!")) text = text.slice(text.indexOf("\n") + 1);
  text = text.replace(/^\s+/, "");
  if (ext === ".py") {
    const match = /^("""|''')([\s\S]*?)\1/.exec(text);
    return match ? match[2] : null;
  }
  // A shell script (by extension or shebang) and a systemd unit both open with a `#` run.
  if (ext === ".sh" || ext === ".service" || ext === "") return lineRun(text, "#");
  if (text.startsWith("/*")) {
    const end = text.indexOf("*/");
    // Without the ` * ` gutter, so an indented snippet or a `$ ` line inside a JSDoc block is seen as one.
    return end === -1 ? null : text.slice(2, end).replace(/^[ \t]*\*(?!\/)/gm, "");
  }
  if (text.startsWith("//")) return lineRun(text, "//");
  return null;
}

function lineRun(text, marker) {
  const lines = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(marker)) break;
    lines.push(line.slice(marker.length));
  }
  return lines.length ? lines.join("\n") : null;
}

const EXAMPLE = /@example|@usage|Example::|Examples::|Usage::|```|^\s*\$ |^ {2,}\S+.*\(/m;

const failures = [];
let passed = 0;
for (const dir of ROOTS) {
  for (const path of walk(join(root, dir))) {
    const rel = relative(root, path).split(sep).join("/");
    const header = headerOf(readFileSync(path, "utf8"), extname(path));
    if (header === null || header.trim().length < 40) {
      failures.push(`${rel}: no header (a comment or docstring at the top that says what this file is for)`);
      continue;
    }
    if (!EXAMPLE.test(header)) {
      failures.push(`${rel}: the header has no usage example (@example, a $ command line, a fenced or indented snippet)`);
      continue;
    }
    passed += 1;
    if (list) console.log(`ok   ${rel}`);
  }
}

for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`check-headers: ${passed} files pass, ${failures.length} fail`);
process.exit(failures.length === 0 ? 0 : 1);
