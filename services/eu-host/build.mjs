#!/usr/bin/env node
/**
 * Builds what the eu-west host stack deploys: `dist/bundle/` (the host bundle the instance downloads at boot — the
 * worker bundled by esbuild for Node 22 arm64, the Python worker and its requirements rendered from `pins.json`, the
 * systemd units, the helper scripts, the CloudWatch agent config, the pinned root JWK, and `zudocs.env` — the
 * identifiers and table names from `airprompter.config.json` and `infra/cdk.json`, never a key) and `dist/wire/`
 * (the wire function for Lambda). What was tested is what deploys: every dependency is inside the bundle.
 *
 *   $ node build.mjs            # → dist/bundle/*, dist/wire/index.mjs
 *   $ node build.mjs --check    # build into a temporary directory only (CI proves it builds)
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHostEnv, renderRequirements } from "./render.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..");
const check = process.argv.includes("--check");
const out = check ? mkdtempSync(join(tmpdir(), "zudocs-eu-host-")) : join(here, "dist");
const bundleDir = join(out, "bundle");
mkdirSync(join(bundleDir, "units"), { recursive: true });
mkdirSync(join(bundleDir, "bin"), { recursive: true });
mkdirSync(join(out, "wire"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: false,
  mainFields: ["module", "main"],
  banner: { js: "import { createRequire as __zudocsCreateRequire } from 'node:module'; const require = __zudocsCreateRequire(import.meta.url);" },
  logLevel: "info",
};
await build({ ...common, entryPoints: [join(here, "src", "worker.ts")], outfile: join(bundleDir, "worker.mjs") });
await build({ ...common, entryPoints: [join(here, "src", "wire.ts")], outfile: join(out, "wire", "index.mjs") });

const config = JSON.parse(readFileSync(join(repoRoot, "airprompter.config.json"), "utf8"));
const cdkContext = JSON.parse(readFileSync(join(repoRoot, "infra", "cdk.json"), "utf8")).context;
const pins = JSON.parse(readFileSync(join(here, "pins.json"), "utf8"));
const rootJwk = JSON.parse(readFileSync(join(repoRoot, "keys", `${config.hostedEnvironment}.root.jwk.json`), "utf8"));
if (rootJwk.d !== undefined) throw new Error("keys/ holds public JWKs only");

writeFileSync(join(bundleDir, "zudocs.env"), renderHostEnv(config, cdkContext));
writeFileSync(join(bundleDir, "requirements.txt"), renderRequirements(pins));
writeFileSync(join(bundleDir, "root.jwk.json"), JSON.stringify(rootJwk) + "\n");
cpSync(join(here, "host", "pyworker.py"), join(bundleDir, "pyworker.py"));
cpSync(join(here, "host", "cloudwatch-agent.json"), join(bundleDir, "cloudwatch-agent.json"));
for (const unit of ["airprompterd.service", "zudocs-worker.service", "zudocs-pyworker.service"]) cpSync(join(here, "host", "units", unit), join(bundleDir, "units", unit));
for (const bin of ["zudocs-agent-key", "zudocs-cli"]) cpSync(join(here, "host", "bin", bin), join(bundleDir, "bin", bin));
console.log(`eu-host built → ${bundleDir} and ${join(out, "wire", "index.mjs")}`);
