#!/usr/bin/env node
/**
 * Seed `./prompts` — the directory `airprompter dev` serves on a laptop — from the release promoted in AirPrompter.
 * Prompt text lives in AirPrompter, not in git, so this is how a developer gets a local copy: sign in as a
 * workspace member (`airprompter login`, which prints the session token), then run this with that token in the
 * environment. It reads the environment's promoted release through the workspace API and writes one file per slot
 * (front matter: tag, model, version, variables, checks, inference; then the version's text), `release.json` with
 * the environment's apply policy and lease, and `golden/<tag>.json` for every slot that carries a golden set.
 *
 * Nothing printed is prompt text: ids, versions, models, counts and file names only. The directory is gitignored.
 *
 * @example
 * ```sh
 * eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
 * npm run prompts:seed                      # writes ./prompts from the dev release
 * npm run prompts:seed -- --out ./tmp/p     # somewhere else
 * ```
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readConfig, repoRoot, secretFromEnv } from "./lib/config.mjs";
import { fileFor } from "./lib/promptFiles.mjs";

const argv = process.argv.slice(2);
const outArg = argv.indexOf("--out");
const outDir = resolve(outArg === -1 ? join(repoRoot, "prompts") : argv[outArg + 1]);
const config = readConfig();
const token = secretFromEnv("AIRPROMPTER_SESSION_TOKEN", "the session token `airprompter login` prints");

const api = async (path) => {
  const response = await fetch(`${config.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (response.status === 401) throw new Error("the session token was not accepted; run `airprompter login` again (tokens last about an hour)");
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path}: HTTP ${response.status}, not JSON`);
  }
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.error ?? body.message ?? ""}`.trim());
  return body;
};

const agentPath = `/workspace/${config.workspaceId}/agents/${config.agentId}`;
const board = (await api(`${agentPath}/board`)).board;
const environment = board.environments[config.environment];
if (!environment?.releaseDigest) throw new Error(`${config.environment}: nothing is promoted yet (generation ${environment?.generation ?? 0})`);
const release = (await api(`${agentPath}/releases/${config.environment}/${environment.releaseDigest}`)).release;
const pins = release.pins.filter((pin) => pin.kind === "prompt");
const skipped = release.pins.filter((pin) => pin.kind !== "prompt").map((pin) => pin.tag);

console.log(`agent ${config.agentId} · ${config.environment} · generation ${environment.generation} · release ${environment.releaseDigest.slice(0, 19)}… · policy ${environment.policy?.applyPolicy ?? environment.applyPolicy}`);
if (skipped.length) console.log(`skipped (the dev registry serves prompt slots only): ${skipped.join(", ")}`);

const files = [];
for (const pin of pins) {
  const version = await api(`/team/prompts/${pin.artifactId}/versions/${pin.versionId}`);
  if (typeof version.content !== "string") throw new Error(`${pin.tag}: the version read carried no content`);
  const inference = version.version?.inference ?? null;
  const file = fileFor({ tag: pin.tag, model: pin.model, versionId: pin.versionId, variables: pin.variables ?? [], checks: pin.outputChecks ?? [], inference, text: version.content });
  files.push({ ...file, pin, bytes: Buffer.byteLength(version.content, "utf8") });
  if (pin.goldenSet) {
    const golden = await api(`${agentPath}/slots/${pin.tag}/golden`);
    if (golden.set) files.push({ path: `golden/${pin.tag}.json`, text: `${JSON.stringify(golden.set, null, 2)}\n`, golden: golden.set });
  }
}

// Write only after every read succeeded, so a failed run never leaves a half-seeded directory behind.
const kept = new Set(["README.md", ".airprompter-dev"]);
mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(outDir)) if (!kept.has(entry)) rmSync(join(outDir, entry), { recursive: true, force: true });
for (const file of files) {
  const target = join(outDir, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.text);
}
const releaseJson = { applyPolicy: environment.policy?.applyPolicy ?? environment.applyPolicy ?? "auto", leaseSeconds: environment.policy?.leaseSeconds ?? 3600, ...(environment.policy?.onLeaseExpiry ? { onLeaseExpiry: environment.policy.onLeaseExpiry } : {}) };
writeFileSync(join(outDir, "release.json"), `${JSON.stringify(releaseJson, null, 2)}\n`);

for (const file of files) {
  if (file.pin) console.log(`  ${file.path}  ${file.pin.tag} ${file.pin.versionId} ${file.pin.model} · ${file.pin.variables?.length ?? 0} variables · ${file.pin.outputChecks?.length ?? 0} checks · ${file.bytes} bytes`);
  else console.log(`  ${file.path}  golden set ${file.golden.setId}: ${file.golden.cases.length} cases, floor ${file.golden.minPassBps / 100}%`);
}
console.log(`  release.json  ${JSON.stringify(releaseJson)}`);
console.log(`seeded ${outDir}${existsSync(join(outDir, ".airprompter-dev")) ? " (dev keys kept)" : ""}: airprompter dev ${outDir} --daemon`);
