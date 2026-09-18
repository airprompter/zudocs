#!/usr/bin/env node
/**
 * Builds what the airgap stack deploys: `dist/bundle/` — the runtime bundled by esbuild for Node 22 arm64 (every
 * dependency inside: the host cannot install anything), the systemd units and timer, the helper scripts, the pinned
 * root JWK, and `zudocs.env` (identifiers, paths, cadences from `airprompter.config.json` and `infra/cdk.json` —
 * never a key, never a base URL). Node and the CLI are not in here: `npm run airgap:up` stages them in the exchange
 * bucket and the boot verifies them against the pins.
 *
 *   $ node build.mjs            # → dist/bundle/*
 *   $ node build.mjs --check    # build into a temporary directory only (CI proves it builds)
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAirgapEnv } from "./render.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..");
const check = process.argv.includes("--check");
const out = check ? mkdtempSync(join(tmpdir(), "zudocs-airgap-")) : join(here, "dist");
const bundleDir = join(out, "bundle");
mkdirSync(join(bundleDir, "units"), { recursive: true });
mkdirSync(join(bundleDir, "bin"), { recursive: true });

await build({
  entryPoints: [join(here, "src", "runtime.ts")],
  outfile: join(bundleDir, "runtime.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: false,
  mainFields: ["module", "main"],
  banner: { js: "import { createRequire as __zudocsCreateRequire } from 'node:module'; const require = __zudocsCreateRequire(import.meta.url);" },
  logLevel: "info",
});

const config = JSON.parse(readFileSync(join(repoRoot, "airprompter.config.json"), "utf8"));
const cdkContext = JSON.parse(readFileSync(join(repoRoot, "infra", "cdk.json"), "utf8")).context;
const rootJwk = JSON.parse(readFileSync(join(repoRoot, "keys", `${config.hostedEnvironment}.root.jwk.json`), "utf8"));
if (rootJwk.d !== undefined) throw new Error("keys/ holds public JWKs only");

writeFileSync(join(bundleDir, "zudocs.env"), renderAirgapEnv(config, cdkContext));
writeFileSync(join(bundleDir, "root.jwk.json"), JSON.stringify(rootJwk) + "\n");
for (const unit of ["zudocs-airgap.service", "zudocs-airgap-export.service", "zudocs-airgap-export.timer"]) cpSync(join(here, "host", "units", unit), join(bundleDir, "units", unit));
for (const bin of ["zudocs-airgap-export", "zudocs-airgap-probe", "zudocs-airgap-keygen"]) cpSync(join(here, "host", "bin", bin), join(bundleDir, "bin", bin));
console.log(`airgap built → ${bundleDir}`);
