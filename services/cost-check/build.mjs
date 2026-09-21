#!/usr/bin/env node
/**
 * Bundles the cost-check function for Lambda (Node 22, arm64) with esbuild: one ESM file with `scripts/lib/cost.mjs`
 * and the four AWS clients inside (what was tested is what deploys), sources mapped. The site stack points
 * `Code.fromAsset` at `dist/`.
 *
 *   $ node build.mjs            # → dist/index.mjs
 *   $ node build.mjs --check    # bundle to a temporary directory only (CI proves it builds)
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const check = process.argv.includes("--check");
const outdir = check ? mkdtempSync(join(tmpdir(), "zudocs-cost-check-")) : join(here, "dist");

await build({
  entryPoints: [join(here, "src", "handler.mjs")],
  outfile: join(outdir, "index.mjs"),
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
console.log(`cost-check bundled → ${join(outdir, "index.mjs")}`);
