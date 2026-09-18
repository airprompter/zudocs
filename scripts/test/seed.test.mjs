import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planSeed, writeSeed } from "../lib/seed.mjs";
import { parsePromptFile } from "../lib/promptFiles.mjs";

const config = { workspaceId: "ws1", agentId: "agent_1", environment: "dev" };
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GOLDEN_HASH = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A fake of the four console routes the seed reads, with knobs for what a test wants to go wrong. */
function fakeApi(overrides = {}) {
  const calls = [];
  const routes = {
    "/workspace/ws1/agents/agent_1/board": { board: { environments: { dev: { generation: 7, releaseDigest: DIGEST, policy: { applyPolicy: "unlock_required", leaseSeconds: 900, onLeaseExpiry: "halt" } }, staging: { generation: 0, releaseDigest: null, policy: { applyPolicy: "auto", leaseSeconds: 3600 } } } } },
    [`/workspace/ws1/agents/agent_1/releases/dev/${DIGEST}`]: {
      release: {
        pins: [
          { tag: "support.triage", kind: "prompt", artifactId: "p-triage", versionId: "rev-3", model: "amazon.nova-micro", variables: [{ name: "ticket", required: true, trust: "end_user" }], outputChecks: [{ kind: "enum", name: "category", path: "category", values: ["a", "b"] }], inference: { temperatureMilli: 0, maxOutputTokens: 200 }, goldenSet: { setId: "gs_1", cases: 1, contentHash: GOLDEN_HASH, byteLength: 10, minPassBps: 10000 } },
          { tag: "support.reply", kind: "prompt", artifactId: "p-reply", versionId: "rev-2", model: "openai.gpt-5-6-luna", variables: [{ name: "tone", required: false, trust: "operator", default: "friendly" }, { name: "customer_tier", required: true, trust: "operator", source: "runtime" }] },
          { tag: "docs.flow", kind: "workflow", artifactId: "w-1", versionId: "rev-1", model: "openai.gpt-5-6-luna" },
        ],
      },
    },
    "/team/prompts/p-triage/versions/rev-3": { content: "Classify.\n\n{{ticket}}\n", version: { inference: { temperature: 0, maxOutputTokens: 200 } } },
    "/team/prompts/p-reply/versions/rev-2": { content: "Tone: {{tone}}. Plan: {{customer_tier}}.\n" },
    "/workspace/ws1/agents/agent_1/slots/support.triage/golden": { set: { format: "airprompter-golden-set", version: 1, setId: "gs_1", minPassBps: 10000, cases: [{ caseId: "one", variables: { ticket: "x" }, expect: [{ kind: "enum", name: "category", path: "category", values: ["a"] }] }] }, ref: { setId: "gs_1", contentHash: GOLDEN_HASH } },
    ...overrides,
  };
  const api = async (path) => {
    calls.push(path);
    if (!(path in routes)) throw new Error(`unexpected route ${path}`);
    const answer = routes[path];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { api, calls };
}

test("the plan is one file per prompt pin, the pin's own inference block, the golden set, and release.json from the policy", async () => {
  const { api, calls } = fakeApi();
  const plan = await planSeed({ api, config });
  assert.deepEqual(plan.files.map((f) => f.path), ["support/triage.md", "golden/support.triage.json", "support/reply.md"]);
  assert.deepEqual(plan.skipped, ["docs.flow"], "a workflow pin is named as skipped, never written");
  assert.deepEqual(plan.releaseJson, { applyPolicy: "unlock_required", leaseSeconds: 900, onLeaseExpiry: "halt" });
  assert.match(plan.summary, /generation 7 .* policy unlock_required/);
  const triage = parsePromptFile(plan.files[0].text);
  assert.equal(triage.meta.tag, "support.triage");
  assert.equal(triage.meta.version, "rev-3");
  assert.deepEqual(triage.inference, { temperatureMilli: 0, maxOutputTokens: 200 }, "the wire's integers from the pin, not the version's floats");
  assert.deepEqual(triage.checks, [{ kind: "enum", name: "category", path: "category", values: ["a", "b"] }]);
  assert.equal(triage.body, "Classify.\n\n{{ticket}}");
  const reply = parsePromptFile(plan.files[2].text);
  assert.equal(reply.meta.variables, "tone=friendly, customer_tier!~");
  assert.deepEqual(JSON.parse(plan.files[1].text).cases.length, 1);
  assert.ok(!calls.some((c) => c.includes("w-1")), "nothing is read for the workflow pin");
  for (const file of plan.files) assert.ok(!file.summary.includes("Classify") && !file.summary.includes("Tone:"), "summaries carry no text");
});

test("nothing is promoted: refused by name before any other read", async () => {
  const { api, calls } = fakeApi();
  await assert.rejects(planSeed({ api, config: { ...config, environment: "staging" } }), /staging: nothing is promoted yet \(generation 0\)/);
  assert.equal(calls.length, 1);
});

test("a golden set edited after the seal is not the pin's: refused", async () => {
  const { api } = fakeApi({ "/workspace/ws1/agents/agent_1/slots/support.triage/golden": { set: { setId: "gs_2", cases: [], minPassBps: 10000 }, ref: { setId: "gs_2", contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" } } });
  await assert.rejects(planSeed({ api, config }), /golden set \(gs_2\) is not the one the release pinned \(gs_1\)/);
});

test("a renamed response field fails by name, and a missing policy or lease is refused rather than invented", async () => {
  const { api: noContent } = fakeApi({ "/team/prompts/p-reply/versions/rev-2": { text: "Tone: {{tone}}." } });
  await assert.rejects(planSeed({ api: noContent, config }), /support.reply rev-2: the response carried no content/);
  const { api: noLease } = fakeApi({ "/workspace/ws1/agents/agent_1/board": { board: { environments: { dev: { generation: 7, releaseDigest: DIGEST, policy: { applyPolicy: "auto" } } } } } });
  await assert.rejects(planSeed({ api: noLease, config }), /policy: the response carried no leaseSeconds/);
});

test("writeSeed replaces a registry directory but keeps the keep file and the dev keys, and refuses a foreign one", async () => {
  const { api } = fakeApi();
  const plan = await planSeed({ api, config });
  const dir = mkdtempSync(join(tmpdir(), "zudocs-seed-"));
  writeFileSync(join(dir, ".gitkeep"), "");
  mkdirSync(join(dir, ".airprompter-dev"));
  writeFileSync(join(dir, ".airprompter-dev", "generation"), "4\n");
  mkdirSync(join(dir, "support"));
  writeFileSync(join(dir, "support", "stale.md"), "---\ntag: support.stale\n---\nold\n");
  writeFileSync(join(dir, "release.json"), "{}\n");
  writeSeed({ outDir: dir, plan });
  assert.ok(existsSync(join(dir, ".gitkeep")), "the keep file survives");
  assert.equal(readFileSync(join(dir, ".airprompter-dev", "generation"), "utf8"), "4\n", "the dev keys and counter survive");
  assert.ok(!existsSync(join(dir, "support", "stale.md")), "a slot no longer in the release is gone");
  assert.deepEqual(readdirSync(join(dir, "support")).sort(), ["reply.md", "triage.md"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "release.json"), "utf8")), plan.releaseJson);
  assert.ok(existsSync(join(dir, "golden", "support.triage.json")));

  const foreign = mkdtempSync(join(tmpdir(), "zudocs-foreign-"));
  writeFileSync(join(foreign, "README.md"), "# not a registry\n");
  assert.throws(() => writeSeed({ outDir: foreign, plan }), /holds README.md .* refusing/);
  assert.ok(existsSync(join(foreign, "README.md")), "nothing was deleted");
  const project = mkdtempSync(join(tmpdir(), "zudocs-project-"));
  writeFileSync(join(project, "package.json"), "{}\n");
  assert.throws(() => writeSeed({ outDir: project, plan }), /holds package.json/);
  const fresh = join(mkdtempSync(join(tmpdir(), "zudocs-fresh-")), "prompts");
  writeSeed({ outDir: fresh, plan });
  assert.ok(existsSync(join(fresh, "support", "triage.md")), "a directory that does not exist yet is created");
});
