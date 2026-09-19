#!/usr/bin/env node
/**
 * A third-party spool writer's segment, checked against the spool contract with the released CLI — no key, no
 * network, no SDK: the SDK repository's `examples/spool-writer` (a plain Node module that writes NDJSON window rows
 * the way the SDK does) is fetched from GitHub at the pinned tag's commit and its digest checked, one writer
 * observes a handful of content-free rows into a scratch spool, closes the segment, and `airprompter telemetry
 * validate` inspects every line the way the uploader would — a segment that passes here is never quarantined there.
 * The weekly workflow runs this; the strip records it. Exit 1 when the CLI refuses the segment.
 *
 * @example
 * ```sh
 * AIRPROMPTER_CLI=.bin/airprompter node scripts/ci-telemetry-validate.mjs          # prints the validate document
 * node scripts/ci-telemetry-validate.mjs --keep                                     # leaves the scratch spool for a look
 * ```
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The SDK repository's example writer, at the commit the CLI release tag names; the digest is checked before it is loaded. */
export const SPOOL_WRITER = Object.freeze({
  commit: "ee2ed19fb62e38aa4808c7d67e312dafa7164481",
  path: "examples/spool-writer/typescript/spool-writer.mjs",
  url: "https://raw.githubusercontent.com/airprompter/airprompter-agent-sdk/ee2ed19fb62e38aa4808c7d67e312dafa7164481/examples/spool-writer/typescript/spool-writer.mjs",
  sha256: "3c1e884de23dde21290cb1f46c63bc99900e2f76385791f88052427f8e7b587f",
});

const args = process.argv.slice(2);
const cli = process.env.AIRPROMPTER_CLI ?? join(process.cwd(), ".bin", "airprompter");
const cache = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache"), "zudocs", "spool-writer");
const keep = args.includes("--keep");

async function fetchWriter() {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `spool-writer-${SPOOL_WRITER.commit.slice(0, 12)}.mjs`);
  if (!existsSync(file)) {
    const response = await fetch(SPOOL_WRITER.url);
    if (!response.ok) throw new Error(`fetching the spool writer: HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (process.env.ZUDOCS_SPOOL_WRITER_SHA256 === "print") console.log(`spool-writer sha256 ${digest}`);
  if (digest !== SPOOL_WRITER.sha256) {
    rmSync(file, { force: true });
    throw new Error(`the spool writer's digest is ${digest}, not the pinned ${SPOOL_WRITER.sha256} (scripts/ci-telemetry-validate.mjs)`);
  }
  return file;
}

const writerPath = await fetchWriter();
const { SpoolWriter } = await import(pathToFileURL(writerPath).href);
const scratch = mkdtempSync(join(tmpdir(), "zudocs-spool-"));
const instanceId = "i-zudocs-ci-writer";
const dir = join(scratch, "airprompter", "agent_ci", "dev", "spool", "telemetry");
const spool = new SpoolWriter({ dir, instanceId, sdk: "zudocs-ci-writer/0.1.0" });
// Content-free rows: a tag, a version, an arm, a model, a status and numbers — never text.
for (let i = 0; i < 6; i += 1) spool.observe({ tag: "support.triage", versionId: "rev-2", arm: "none", model: "amazon.nova-micro", status: i === 5 ? "error" : "ok", ...(i === 5 ? { errorClass: "provider_timeout" } : {}), latencyMs: 400 + i * 10, tokens: { input: 120, cachedInput: 0, output: 30 } });
spool.feedback({ tag: "support.reply", versionId: "rev-3", arm: "none", model: "amazon.nova-2-lite", outcomes: { accepted: true } });
spool.close();
const segments = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => join(dir, f));
if (segments.length === 0) throw new Error(`the writer left no closed segment in ${dir}`);
console.log(`spool-writer (${SPOOL_WRITER.commit.slice(0, 12)}): ${segments.length} segment(s), ${segments.map((s) => `${s.split("/").pop()} ${readFileSync(s, "utf8").split("\n").filter(Boolean).length} rows`).join(", ")}`);
const out = spawnSync(cli, ["telemetry", "validate", ...segments, "--json"], { encoding: "utf8" });
const last = out.stdout.trim().split("\n").pop() ?? "";
console.log(`airprompter telemetry validate → exit ${out.status}`);
console.log(last);
if (out.stderr.trim()) console.log(`[stderr] ${out.stderr.trim().slice(0, 400)}`);
if (!keep) rmSync(scratch, { recursive: true, force: true });
else console.log(`kept ${scratch}`);
process.exit(out.status === 0 ? 0 : 1);
