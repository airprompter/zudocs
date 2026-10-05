#!/usr/bin/env node
/**
 * Seed `./prompts` — the directory `airprompter dev` serves on a laptop — from the release promoted in AirPrompter.
 * Prompt text lives in AirPrompter, not in git, so this is how a developer gets a local copy: with the
 * zudocs-support Agent key in the environment (`AIRPROMPTER_AGENT_KEY`, the dev key from the console's Keys page),
 * it pulls the environment's promoted release through the public SDK (`pullBundle`, verified against the pinned
 * root in `keys/`; `scripts/lib/seed.mjs`) and writes one file per slot (front matter: tag, model, version,
 * variables, checks, inference; then the version's text), `release.json` with the release's apply policy and lease,
 * and `golden/<tag>.json` for every slot that carries a golden set — only after the pull and every check succeeded,
 * and only into a directory that holds nothing but a registry. Dev only: the bundle is plaintext, which the SDK
 * allows on the dev target alone.
 *
 * Nothing printed is prompt text: ids, versions, models, counts and file names only. The directory is gitignored;
 * an `--out` elsewhere must be outside every repository too, since what it writes is content.
 *
 * @example
 * ```sh
 * set -a; . ~/.config/zudocs/dev.env; set +a          # AIRPROMPTER_AGENT_KEY, never on a command line
 * npm run prompts:seed                                # writes ./prompts from the dev release
 * npm run prompts:seed -- --out /tmp/zudocs-prompts   # somewhere outside the tree
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfig, repoRoot, secretFromEnv } from "./lib/config.mjs";
import { planSeed, pullRelease, writeSeed } from "./lib/seed.mjs";

const argv = process.argv.slice(2);
let outDir = join(repoRoot, "prompts");
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out" && i + 1 < argv.length && !argv[i + 1].startsWith("-") && argv[i + 1].trim()) {
    if (argv.indexOf("--out") !== i) usage("--out was given twice");
    outDir = resolve(argv[i + 1]);
    i += 1;
  } else usage(`unknown argument ${JSON.stringify(argv[i])} — the only option is --out <directory>`);
}
function usage(message) {
  console.log(message);
  process.exit(2);
}
let config;
let apiKey;
let rootJwk;
try {
  config = readConfig();
  apiKey = secretFromEnv("AIRPROMPTER_AGENT_KEY", "the zudocs-support Agent key for dev (the console's Keys page; RUNBOOK.md › Keys)");
  rootJwk = JSON.parse(readFileSync(join(repoRoot, "keys", `${config.hostedEnvironment}.root.jwk.json`), "utf8"));
} catch (error) {
  console.log(error.message);
  process.exit(2);
}

try {
  const result = await pullRelease({ config, apiKey, rootJwk });
  const plan = planSeed({ result, config });
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
