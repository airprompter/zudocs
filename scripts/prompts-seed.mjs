#!/usr/bin/env node
/**
 * Seed `./prompts` — the directory `airprompter dev` serves on a laptop — from the release promoted in AirPrompter.
 * Prompt text lives in AirPrompter, not in git, so this is how a developer gets a local copy: sign in as a
 * workspace member (`airprompter login`, which prints the session token), then run this with that token in the
 * environment. It reads the environment's promoted release through the workspace API (`scripts/lib/seed.mjs`)
 * and writes one file per slot (front matter: tag, model, version, variables, checks, inference; then the
 * version's text), `release.json` with the environment's apply policy and lease, and `golden/<tag>.json` for every
 * slot that carries a golden set — only after every read succeeded, and only into a directory that holds nothing
 * but a registry.
 *
 * Nothing printed is prompt text: ids, versions, models, counts and file names only. The directory is gitignored;
 * an `--out` elsewhere must be outside every repository too, since what it writes is content.
 *
 * @example
 * ```sh
 * eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
 * npm run prompts:seed                                # writes ./prompts from the dev release
 * npm run prompts:seed -- --out /tmp/zudocs-prompts   # somewhere outside the tree
 * ```
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfig, repoRoot, secretFromEnv } from "./lib/config.mjs";
import { planSeed, writeSeed } from "./lib/seed.mjs";

const argv = process.argv.slice(2);
const outArg = argv.indexOf("--out");
if (outArg !== -1 && (argv[outArg + 1] === undefined || argv[outArg + 1].startsWith("--"))) {
  console.log("--out takes a directory");
  process.exit(2);
}
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

try {
  const plan = await planSeed({ api, config });
  console.log(plan.summary);
  if (plan.skipped.length) console.log(`skipped (the dev registry serves prompt slots only): ${plan.skipped.join(", ")}`);
  writeSeed({ outDir, plan });
  for (const file of plan.files) console.log(`  ${file.path}  ${file.summary}`);
  console.log(`  release.json  ${JSON.stringify(plan.releaseJson)}`);
  console.log(`seeded ${outDir}${existsSync(join(outDir, ".airprompter-dev")) ? " (dev keys kept)" : ""}: airprompter dev ${outDir} --daemon`);
} catch (error) {
  console.log(`seed failed: ${error.message}`);
  process.exit(1);
}
