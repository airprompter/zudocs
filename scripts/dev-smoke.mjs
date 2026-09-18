#!/usr/bin/env node
/**
 * The laptop smoke: prove the seeded `./prompts` directory serves the way the desk will consume it, with no model
 * and no AirPrompter. It starts `airprompter dev ./prompts --daemon` (the CLI on `AIRPROMPTER_CLI`, else
 * `.bin/airprompter`, else `airprompter` on PATH), attaches the public SDK to the daemon's socket the way a host
 * process does, and for every slot: names what the call site still has to pass (`needs`), renders it —
 * `customer_tier` from a tiny in-script customer table registered as a variable source, `tone` from its declared
 * default, the ticket fenced as end-user text — and runs the slot's declared output checks against a canned answer.
 * Each claim is proved by comparing two renders (two customers, a passed tone against the default) or by finding the
 * exact fenced value; it prints generation, version, model, arm, counts and verdicts, and no prompt text at all.
 *
 * What the dev registry cannot carry is said, not hidden: the CLI's front matter has no `checks:` line, so the
 * daemon serves the release without them and `ap.checks()` finds none — the checks are read from the seeded file
 * and evaluated with the same public evaluator the runtime uses. Exit 1 when a render, a check or the daemon fails.
 *
 * @example
 * ```sh
 * npm run prompts:seed && npm run dev:smoke
 * AIRPROMPTER_CLI=/usr/local/bin/airprompter node scripts/dev-smoke.mjs ./prompts
 * ```
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AirPrompterAgent, checksRefusals, evaluateChecks } from "@airprompter/agent-sdk";
import { readConfig, repoRoot } from "./lib/config.mjs";
import { parsePromptFile } from "./lib/promptFiles.mjs";

const promptsDir = resolve(process.argv[2] ?? join(repoRoot, "prompts"));
const cli = process.env.AIRPROMPTER_CLI ?? (existsSync(join(repoRoot, ".bin", "airprompter")) ? join(repoRoot, ".bin", "airprompter") : "airprompter");
const stateDir = join(promptsDir, ".airprompter-dev", "state");
const scope = { organizationId: "org_dev", agentId: "agt_dev", target: "dev" };
const config = readConfig();

/** The application's own record of who is on which plan — the desk's customer table, in miniature. */
const customers = new Map([
  ["cust-1001", { name: "Acme Docs", tier: "team" }],
  ["cust-2002", { name: "Nimbus Labs", tier: "trial" }],
  ["cust-3003", { name: "Orbital Bank", tier: "enterprise" }],
]);

/** What each slot is rendered with, a second customer to compare against, and a canned answer of the right shape. */
const TICKET = "Search still returns a page we deleted last week. Clicking it gives a 404.";
const SUMMARY = "Symptom: a deleted page still appears in search and 404s when opened.\nWhere: search; page not named.\nSince: last week.\nTried: not stated.\nImpact: the team sees stale results.\nUnknown: the page URL; whether other deleted pages show too.";
const CASES = {
  "support.triage": { values: { ticket: TICKET }, subject: "cust-1001", other: "cust-2002", answer: '{"category":"search","priority":"normal","summary":"A deleted page still appears in search results and returns 404."}' },
  "support.reply": { values: { ticket: TICKET }, subject: "cust-2002", other: "cust-3003", answer: "Thanks for flagging this — a deleted page lingering in search is our index running behind. I have queued a re-index of your space; results usually catch up within the hour. Your trial includes full search, so nothing to change on your side. If it is still there tomorrow, send me the page URL and I will look directly.\n\nThe Zudocs team" },
  "support.escalate.summary": { values: { ticket: TICKET }, subject: "cust-1001", other: "cust-2002", answer: SUMMARY },
  "support.escalate.handoff": { values: { summary: SUMMARY }, subject: "cust-3003", other: "cust-1001", answer: "Title: Deleted page still in search (search)\nSeverity: S3 — a defect with a workaround (open the page from the tree)\nPlan: enterprise; copy the account manager, respond within four hours\nFacts:\n- deleted page still listed\n- opening it gives 404\n- since last week\nAsk: check the index for tombstoned pages; ask the customer for the page URL." },
};

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

const files = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(md|txt|prompt)$/i.test(entry)) files.push(path);
  }
})(promptsDir);
if (files.length === 0) {
  console.log(`${promptsDir} holds no prompt files — run \`npm run prompts:seed\` first`);
  process.exit(1);
}

// ---- 1. the registry: airprompter dev --daemon on the seeded directory
const dev = spawn(cli, ["dev", promptsDir, "--daemon", "--port", "0", "--state-dir", stateDir, "--poll-seconds", "1", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
const devLog = [];
dev.stderr.on("data", (chunk) => devLog.push(...String(chunk).split("\n").filter(Boolean)));
let ap = null;
try {
  const registry = await new Promise((resolvePromise, reject) => {
    let buffer = "";
    dev.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.baseUrl) resolvePromise(parsed);
        } catch {
          // not the handshake line
        }
      }
    });
    dev.on("error", (error) => reject(new Error(`could not start ${cli}: ${error.message} (install the released CLI at .bin/airprompter, or set AIRPROMPTER_CLI)`)));
    dev.on("exit", (code) => reject(new Error(`airprompter dev exited with ${code}: ${devLog.slice(-3).join(" | ")}`)));
    setTimeout(() => reject(new Error(`airprompter dev did not answer in 20 s: ${devLog.slice(-3).join(" | ")}`)), 20_000).unref();
  });
  console.log(`registry ${registry.baseUrl} · generation ${registry.generation} · policy ${registry.applyPolicy} · daemon ${registry.daemonSocket ? "listening" : "absent"}`);
  console.log(`  slots: ${registry.slots.join("; ")}`);
  if (!registry.daemonSocket) throw new Error("no daemon socket in the dev output (was --daemon honoured?)");

  // ---- 2. the SDK attached to the daemon, with the application's own variable source
  ap = await AirPrompterAgent.start({
    ...scope,
    stateDir,
    root: { pinned: JSON.parse(readFileSync(registry.root, "utf8")), hostedEnvironment: "dev" },
    sync: { mode: "daemon", daemonSocketPath: registry.daemonSocket },
    telemetry: { upload: false },
    models: config.models,
    variables: {
      customer_tier: { resolve: async ({ subject }) => customers.get(subject)?.tier, trust: "operator", timeoutMs: 500 },
    },
  });
  // A restarted registry is a new generation (the counter persists so a client never sees a fresh N); the daemon
  // applies it on its first poll and hands it to attached SDKs as a `generation` event — give that one poll or two.
  const attachedAt = ap.generation;
  for (let waited = 0; ap.generation < registry.generation && waited < 10_000; waited += 250) await new Promise((r) => setTimeout(r, 250));
  const status = ap.status();
  console.log(`sdk attached · source ${status.source} · generation ${ap.generation}${attachedAt !== ap.generation ? ` (attached at ${attachedAt}, the daemon handed over ${ap.generation})` : ""} · apply ${status.applyState} · sources ${JSON.stringify(status.variables.sources)} · unsourced ${JSON.stringify(status.variables.unsourced)}`);
  if (ap.generation !== registry.generation) fail(`the SDK holds generation ${ap.generation}, the registry serves ${registry.generation}`);
  if (!status.daemon?.attached) fail("the SDK is not attached to the daemon (it fell back to its own store)");

  // ---- 3. every slot: needs, render, fill, fence, checks
  for (const path of files) {
    const parsed = parsePromptFile(readFileSync(path, "utf8"));
    const tag = parsed.meta.tag ?? relative(promptsDir, path).replace(/\.(md|txt|prompt)$/i, "").split("/").join(".").toLowerCase();
    const scenario = CASES[tag];
    console.log(`\n${tag}  (${relative(repoRoot, path)})`);
    if (!scenario) { fail("no smoke scenario for this slot — add one to CASES"); continue; }
    // The CLI's own reading of the file, from its --json handshake: "<tag> (<model>, <n> vars)".
    const served = registry.slots.find((line) => line.startsWith(`${tag} (`));
    const servedVars = served ? Number(/, (\d+) vars\)$/.exec(served)?.[1]) : NaN;
    if (servedVars === parsed.variables.length) ok(`the CLI reads ${servedVars} declared variable(s) from the file, as this grammar does`);
    else fail(`the CLI reads ${served ?? "no such slot"}; the file declares ${parsed.variables.length} variables`);

    const handle = ap.prompt(tag, { subject: scenario.subject });
    const declared = handle.variables();
    const needs = handle.needs(scenario.values);
    console.log(`  declared: ${declared.map((v) => `${v.name}${v.required ? "!" : ""}${v.trust === "end_user" ? "?" : ""}${v.source === "runtime" ? "~" : ""}${v.default ? `=${v.default}` : ""}`).join(", ")} · needs after the call site's values: ${JSON.stringify(needs)}`);
    if (needs.length) fail(`the call site would still miss ${needs.join(", ")}`);
    let rendered;
    try {
      rendered = await handle.renderAsync(scenario.values);
    } catch (error) {
      fail(`render: ${error.name} ${error.message}`);
      continue;
    }
    ok(`rendered ${rendered.versionId} on ${rendered.model} (arm ${rendered.arm}, generation ${ap.generation}, ${rendered.text.length} chars)`);
    if (rendered.versionId !== parsed.meta.version) fail(`the daemon serves version ${rendered.versionId}, the file says ${parsed.meta.version}`);
    if (rendered.model !== parsed.meta.model) fail(`the daemon serves model ${rendered.model}, the file says ${parsed.meta.model}`);
    if (rendered.text.includes("{{")) fail("a literal {{placeholder}} survived the render");
    for (const variable of declared) {
      if (variable.trust === "end_user") {
        const value = scenario.values[variable.name];
        if (rendered.text.includes(`<${variable.name}>${value}</${variable.name}>`)) ok(`${variable.name}: the call site's value is in the render fenced as <${variable.name}>…</${variable.name}>`);
        else fail(`${variable.name} is declared end-user but the render does not carry the value fenced`);
      }
      if (variable.source === "runtime") {
        // Two customers, one prompt: the renders differ in exactly one span, and it is the two tiers.
        const other = await ap.prompt(tag, { subject: scenario.other }).renderAsync(scenario.values);
        const span = differingSpan(rendered.text, other.text);
        const tiers = [customers.get(scenario.subject).tier, customers.get(scenario.other).tier];
        if (span && span[0] === tiers[0] && span[1] === tiers[1]) ok(`${variable.name}: filled from the customer table — ${scenario.subject} renders "${tiers[0]}", ${scenario.other} renders "${tiers[1]}", nothing else differs`);
        else fail(`${variable.name}: the renders for ${scenario.subject} and ${scenario.other} differ by ${JSON.stringify(span)}, expected ${JSON.stringify(tiers)}`);
      }
      if (variable.default !== undefined && !(variable.name in scenario.values)) {
        // Passing the variable changes exactly one span: the default becomes the value.
        const passed = await handle.renderAsync({ ...scenario.values, [variable.name]: "formal" });
        const span = differingSpan(rendered.text, passed.text);
        if (span && span[0] === variable.default && span[1] === "formal") ok(`${variable.name}: nobody passed it and the declared default "${variable.default}" rendered; passing "formal" replaces exactly that`);
        else fail(`${variable.name}: expected the default "${variable.default}" to be the one difference, got ${JSON.stringify(span)}`);
      }
    }
    if (rendered.text.includes("## Success criteria")) ok("carries a ## Success criteria section for ap.judge(…, \"prompt\")");
    if (parsed.inference) ok(`version settings in the file (the pin's wire form): ${JSON.stringify(parsed.inference)}${rendered.inference ? ` · on the dev wire as ${JSON.stringify(rendered.inference)}` : " · not on the dev wire (the dev grammar has no inference line)"}`);

    const fromDaemon = ap.checks(rendered, scenario.answer, { record: false });
    const refusals = checksRefusals(parsed.checks);
    if (refusals.length) fail(`checks refused by the evaluator: ${JSON.stringify(refusals)}`);
    const outcome = evaluateChecks(parsed.checks, { text: scenario.answer, outputTokens: null });
    for (const result of outcome.results) (result.verdict === "pass" ? ok : fail)(`check ${result.name} (${result.kind}): ${result.verdict === "pass" ? "pass" : `fail — ${result.reason}`}`);
    console.log(`  checks: ${outcome.passed} passed, ${outcome.failed} failed, ${parsed.checks.length} declared in the file · ${fromDaemon.results.length} declared on the dev wire (the dev grammar has no checks line)`);
  }

  // ---- 4. golden sets seeded beside the prompts (shape only: a golden run needs the model)
  const goldenDir = join(promptsDir, "golden");
  if (existsSync(goldenDir)) {
    for (const entry of readdirSync(goldenDir).sort()) {
      const set = JSON.parse(readFileSync(join(goldenDir, entry), "utf8"));
      const refused = set.cases.flatMap((c) => checksRefusals(c.expect).map((r) => `${c.caseId}: ${JSON.stringify(r)}`));
      console.log(`\ngolden ${entry}: set ${set.setId}, ${set.cases.length} cases, floor ${set.minPassBps / 100}%${refused.length ? ` — refused expectations ${refused.join("; ")}` : ""}`);
      if (refused.length) failures += 1;
    }
  }

  // ---- 5. the CLI asks the daemon
  const cliStatus = spawnSync(cli, ["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"], { encoding: "utf8" });
  const statusLine = (cliStatus.stdout ?? "").trim().split("\n").at(-1) ?? "";
  let doc = null;
  try {
    doc = JSON.parse(statusLine);
  } catch {
    fail(`airprompter status did not answer as JSON (exit ${cliStatus.status}): ${(cliStatus.stderr ?? "").trim().slice(0, 200)}`);
  }
  if (doc) {
    console.log(`\nairprompter status: generation ${doc.generation} · active slot ${doc.activeSlot} (${doc.active?.slots ?? 0} slots, verified ${doc.active?.verified}) · policy ${doc.applyPolicyPin?.value} · ${doc.storageProtection} · daemon ${doc.daemon?.pid ? `${doc.daemon.daemon} pid ${doc.daemon.pid}` : "not answering"}`);
    if (!doc.daemon?.pid) fail("airprompter status was not answered by the daemon");
  }
} catch (error) {
  fail(String(error.message));
} finally {
  if (ap) await ap.stop();
  if (dev.pid && dev.exitCode === null) {
    dev.kill("SIGTERM");
    await new Promise((resolvePromise) => dev.once("exit", resolvePromise));
  }
}
const problems = devLog.filter((line) => line.includes("\"problem\""));
if (problems.length) { console.log(`\nairprompter dev reported problems:\n${problems.join("\n")}`); failures += problems.length; }
console.log(`\n${failures === 0 ? "smoke ok" : `smoke failed: ${failures} problem(s)`}`);
process.exit(failures === 0 ? 0 : 1);
