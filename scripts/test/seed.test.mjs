import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planSeed, pullRelease, writeSeed } from "../lib/seed.mjs";
import { parsePromptFile } from "../lib/promptFiles.mjs";

const config = { baseUrl: "https://api.test", rootUrl: "https://edge.test/roots/dev/root.json", hostedEnvironment: "dev", organizationId: "org_1", agentId: "agent_1", environment: "dev" };
const hashOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const entry = (text) => { const bytes = Buffer.from(text, "utf8"); return { contentHash: hashOf(bytes), byteLength: bytes.length, bytes: bytes.toString("base64url") }; };

/** A pull result as `pullBundle` answers it for a plaintext dev bundle, with knobs for what a test wants to go wrong. */
function fakeResult({ payload: patch = {}, payloads: extra = [], drop = null } = {}) {
  const triage = entry("Classify.\n\n{{ticket}}\n");
  const reply = entry("Tone: {{tone}}. Plan: {{customer_tier}}.\n");
  const golden = entry(JSON.stringify({ format: "airprompter-golden-set", version: 1, setId: "gs_1", minPassBps: 10000, cases: [{ caseId: "one", variables: { ticket: "x" }, expect: [{ kind: "enum", name: "category", path: "category", values: ["a"] }] }] }));
  const flow = entry("workflow body");
  const payload = {
    organizationId: "org_1", agentId: "agent_1", target: "dev", generation: 7, releaseDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    applyPolicy: "unlock_required", leaseSeconds: 900, onLeaseExpiry: "halt", directives: [],
    slots: [
      { tag: "support.triage", kind: "prompt", artifactId: "p-triage", versionId: "rev-3", contentHash: triage.contentHash, byteLength: triage.byteLength, model: "amazon.nova-micro", variables: [{ name: "ticket", required: true, trust: "end_user" }], outputChecks: [{ kind: "enum", name: "category", path: "category", values: ["a", "b"] }], inference: { temperatureMilli: 0, maxOutputTokens: 200 }, goldenSet: { setId: "gs_1", cases: 1, contentHash: golden.contentHash, byteLength: golden.byteLength, minPassBps: 10000 } },
      { tag: "support.reply", kind: "prompt", artifactId: "p-reply", versionId: "rev-2", contentHash: reply.contentHash, byteLength: reply.byteLength, model: "openai.gpt-5-6-luna", variables: [{ name: "tone", required: false, trust: "operator", default: "friendly" }, { name: "customer_tier", required: true, trust: "operator", source: "runtime" }] },
      { tag: "docs.flow", kind: "workflow", artifactId: "w-1", versionId: "rev-1", contentHash: flow.contentHash, byteLength: flow.byteLength, model: "openai.gpt-5-6-luna", variables: [] },
    ],
    ...patch,
  };
  const payloads = [triage, reply, golden, flow, ...extra].filter((p) => p.contentHash !== drop);
  return { status: "ok", generation: payload.generation, releaseDigest: payload.releaseDigest, bundle: { format: "apbundle", version: 1, protocol: "0.3", encryption: { scheme: "none", contents: { createdAt: "t", notAfter: "t", manifest: { payload, signatures: [] }, keySet: {}, payloads } } }, hashes: { triage: triage.contentHash, golden: golden.contentHash } };
}

test("the plan is one file per prompt slot, the slot's own inference block, the golden set from the bundle, and release.json from the manifest", () => {
  const plan = planSeed({ result: fakeResult(), config });
  assert.deepEqual(plan.files.map((f) => f.path), ["support/triage.md", "golden/support.triage.json", "support/reply.md"]);
  assert.deepEqual(plan.skipped, ["docs.flow"], "a workflow slot is named as skipped, never written");
  assert.deepEqual(plan.releaseJson, { applyPolicy: "unlock_required", leaseSeconds: 900, onLeaseExpiry: "halt" });
  assert.match(plan.summary, /generation 7 .* policy unlock_required/);
  const triage = parsePromptFile(plan.files[0].text);
  assert.equal(triage.meta.tag, "support.triage");
  assert.equal(triage.meta.version, "rev-3");
  assert.deepEqual(triage.inference, { temperatureMilli: 0, maxOutputTokens: 200 }, "the wire's integers from the slot");
  assert.deepEqual(triage.checks, [{ kind: "enum", name: "category", path: "category", values: ["a", "b"] }]);
  assert.equal(triage.body, "Classify.\n\n{{ticket}}");
  const reply = parsePromptFile(plan.files[2].text);
  assert.equal(reply.meta.variables, "tone=friendly, customer_tier!~");
  assert.deepEqual(JSON.parse(plan.files[1].text).cases.length, 1);
  for (const file of plan.files) assert.ok(!file.summary.includes("Classify") && !file.summary.includes("Tone:"), "summaries carry no text");
});

test("a pull that gave no bundle is refused in words: nothing promoted, a refused key, the SDK's refusal, a sealed bundle", () => {
  assert.throws(() => planSeed({ result: { status: "nothing_promoted", edge: {} }, config }), /dev: nothing is promoted yet/);
  assert.throws(() => planSeed({ result: { status: "unavailable", reason: "unauthorized", edge: {} }, config }), /Agent key was not accepted \(AIRPROMPTER_AGENT_KEY/);
  assert.throws(() => planSeed({ result: { status: "refused", reason: "signature_invalid", edge: {} }, config }), /SDK refused the release: signature_invalid/);
  const sealed = fakeResult();
  sealed.bundle.encryption = { scheme: "hpke-x25519-hkdf-sha256-aes-256-gcm", recipientKeyId: "k", enc: "e", ciphertext: "c" };
  assert.throws(() => planSeed({ result: sealed, config }), /the bundle is sealed/);
});

test("the bytes written are the release's: a payload that does not hash to its name, a missing one, or another scope is refused", () => {
  const tampered = fakeResult();
  const payloads = tampered.bundle.encryption.contents.payloads;
  payloads[0] = { ...payloads[0], bytes: Buffer.from("Something else.\n").toString("base64url") };
  assert.throws(() => planSeed({ result: tampered, config }), /do not hash to their content hash/);
  const { hashes } = fakeResult();
  assert.throws(() => planSeed({ result: fakeResult({ drop: hashes.golden }), config }), /support.triage golden set: the bundle carries no payload/);
  assert.throws(() => planSeed({ result: fakeResult({ payload: { agentId: "agent_other" } }), config }), /manifest's agentId is "agent_other"/);
});

test("a renamed bundle field fails by name, and a missing policy or lease is refused rather than invented", () => {
  assert.throws(() => planSeed({ result: fakeResult({ payload: { leaseSeconds: undefined } }), config }), /manifest: the bundle carried no leaseSeconds/);
  assert.throws(() => planSeed({ result: fakeResult({ payload: { applyPolicy: "sometimes" } }), config }), /applyPolicy is "sometimes"/);
  assert.throws(() => planSeed({ result: fakeResult({ payload: { slots: [{ tag: "x", kind: "agent" }] } }), config }), /kind "agent" is not prompt or workflow/);
  assert.throws(() => planSeed({ result: fakeResult({ payload: { slots: [] } }), config }), /names no prompt slot/);
});

test("the pull: a plaintext dev pull through the SDK with the pinned root and the scope; any other environment is refused before a request", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return { status: 200, json: async () => ({ signed: {}, signatures: [] }) }; };
  const pull = async (input) => {
    assert.equal(input.distributionPublicKey, null, "plaintext");
    assert.deepEqual(input.scope, { organizationId: "org_1", agentId: "agent_1", target: "dev" });
    assert.equal(input.trustedRoot.signed.environment, "dev");
    assert.ok(typeof input.client.manifest === "function", "a real SyncClient");
    assert.deepEqual(await input.fetchRoot(), { signed: {}, signatures: [] });
    return fakeResult();
  };
  const rootJwk = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };
  const result = await pullRelease({ config, apiKey: "apa_test_only", rootJwk, fetchImpl, pull });
  assert.equal(result.status, "ok");
  assert.deepEqual(calls, ["https://edge.test/roots/dev/root.json"], "the root document, and nothing else here");
  let pulled = false;
  await assert.rejects(pullRelease({ config: { ...config, environment: "staging" }, apiKey: "apa_test_only", rootJwk, fetchImpl, pull: async () => { pulled = true; } }), /plaintext bundle, which the SDK allows for dev only/);
  assert.equal(pulled, false, "nothing is asked for a sealed environment");
  await assert.rejects(pullRelease({ config, apiKey: "apa_test_only", rootJwk: { ...rootJwk, d: "secret" }, fetchImpl, pull }), /private member/);
});

test("writeSeed replaces a registry directory but keeps the keep file and the dev keys, and refuses a foreign one", async () => {
  const plan = planSeed({ result: fakeResult(), config });
  const dir = mkdtempSync(join(tmpdir(), "zudocs-seed-"));
  writeFileSync(join(dir, ".gitkeep"), "");
  mkdirSync(join(dir, ".airprompter-dev"));
  writeFileSync(join(dir, ".airprompter-dev", "generation"), "4\n");
  mkdirSync(join(dir, "support"));
  writeFileSync(join(dir, "support", "stale.md"), "---\ntag: support.stale\n---\nold\n");
  writeFileSync(join(dir, "release.json"), "{}\n");
  mkdirSync(join(dir, "golden"));
  writeFileSync(join(dir, "golden", "support.stale.json"), "{}\n");
  mkdirSync(join(dir, "old"));
  writeFileSync(join(dir, "old", "slot.md"), "---\ntag: old.slot\n---\nold\n");
  writeSeed({ outDir: dir, plan });
  assert.ok(!existsSync(join(dir, "golden", "support.stale.json")), "a stale golden set is gone");
  assert.ok(!existsSync(join(dir, "old")), "a directory left empty is gone");
  assert.ok(existsSync(join(dir, ".gitkeep")), "the keep file survives");
  assert.equal(readFileSync(join(dir, ".airprompter-dev", "generation"), "utf8"), "4\n", "the dev keys and counter survive");
  assert.ok(!existsSync(join(dir, "support", "stale.md")), "a slot no longer in the release is gone");
  assert.deepEqual(readdirSync(join(dir, "support")).sort(), ["reply.md", "triage.md"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "release.json"), "utf8")), plan.releaseJson);
  assert.ok(existsSync(join(dir, "golden", "support.triage.json")));

  const home = mkdtempSync(join(tmpdir(), "zudocs-home-"));
  for (const name of ["zudocs", "other-app", "my-app"]) mkdirSync(join(home, name));
  writeFileSync(join(home, "notes.md"), "mine\n");
  assert.throws(() => writeSeed({ outDir: home, plan }), /carries no registry marker/, "lower-case names alone are not a registry");
  assert.deepEqual(readdirSync(home).sort(), ["my-app", "notes.md", "other-app", "zudocs"], "nothing was deleted");
  const finder = mkdtempSync(join(tmpdir(), "zudocs-finder-"));
  writeFileSync(join(finder, ".gitkeep"), "");
  writeFileSync(join(finder, ".DS_Store"), "");
  mkdirSync(join(finder, "support"));
  writeFileSync(join(finder, "support", ".DS_Store"), "");
  writeSeed({ outDir: finder, plan });
  assert.ok(!existsSync(join(finder, ".DS_Store")) && !existsSync(join(finder, "support", ".DS_Store")) && existsSync(join(finder, "release.json")), "Finder's droppings are swept at any depth, not refused");
  const foreign = mkdtempSync(join(tmpdir(), "zudocs-foreign-"));
  writeFileSync(join(foreign, ".gitkeep"), "");
  writeFileSync(join(foreign, "README.md"), "# not a registry\n");
  assert.throws(() => writeSeed({ outDir: foreign, plan }), /holds README.md .* refusing/);
  assert.ok(existsSync(join(foreign, "README.md")), "nothing was deleted");
  const project = mkdtempSync(join(tmpdir(), "zudocs-project-"));
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(project, "release.json"), "{}\n");
  assert.throws(() => writeSeed({ outDir: project, plan }), /carries no registry marker/, "somebody else's release.json is not a marker");
  writeFileSync(join(project, "release.json"), JSON.stringify(plan.releaseJson));
  assert.throws(() => writeSeed({ outDir: project, plan }), /holds package.json/, "a marker does not excuse a foreign entry");
  assert.ok(existsSync(join(project, "package.json")), "nothing was deleted");
  const nested = mkdtempSync(join(tmpdir(), "zudocs-nested-"));
  writeFileSync(join(nested, "release.json"), JSON.stringify(plan.releaseJson));
  mkdirSync(join(nested, "src"));
  writeFileSync(join(nested, "src", "index.js"), "");
  assert.throws(() => writeSeed({ outDir: nested, plan }), /holds src\/index.js/, "a foreign file below the top level is found before anything is deleted");
  assert.ok(existsSync(join(nested, "src", "index.js")), "nothing was deleted");
  const linked = mkdtempSync(join(tmpdir(), "zudocs-linked-"));
  const outside = mkdtempSync(join(tmpdir(), "zudocs-outside-"));
  writeFileSync(join(outside, "precious.md"), "keep\n");
  writeFileSync(join(linked, ".gitkeep"), "");
  symlinkSync(outside, join(linked, "support"));
  assert.throws(() => writeSeed({ outDir: linked, plan }), /support \(a symbolic link\)/);
  assert.equal(readFileSync(join(outside, "precious.md"), "utf8"), "keep\n", "nothing behind the link was touched");
  assert.throws(() => writeSeed({ outDir: mkdtempSync(join(tmpdir(), "zudocs-empty-")), plan: { files: [], releaseJson: plan.releaseJson } }), /names no files/);
  const fresh = join(mkdtempSync(join(tmpdir(), "zudocs-fresh-")), "prompts");
  writeSeed({ outDir: fresh, plan });
  assert.ok(existsSync(join(fresh, "support", "triage.md")), "a directory that does not exist yet is created");
});
