/**
 * The seed as three steps: `pullRelease` pulls the environment's promoted release through the public SDK
 * (`pullBundle` with an Agent key, the pinned root and the root document — the same call the puller makes),
 * `planSeed` turns the verified bundle into every file to write, and `writeSeed` replaces a registry directory with
 * that plan. Split so the plan can be tested against a hand-built bundle and the write against a temporary
 * directory, and so nothing is written until the pull and every check succeeded.
 *
 * The bundle is plaintext (`distributionPublicKey: null`), which the SDK permits for the dev target only, so the seed
 * refuses any other environment before it asks. The SDK has already verified the chain and every payload's hash;
 * `planSeed` checks the hash again on the bytes it writes, so a file on disk is always the release's bytes.
 *
 * The write replaces a registry, never an arbitrary directory: a non-empty target must carry a registry marker
 * (`.gitkeep`, `.airprompter-dev/`, or a `release.json` of this seed's own shape), hold nothing but registry-shaped
 * entries at every depth, and contain no symbolic link. New files are written before stale ones are removed, so a
 * failure part-way leaves old and new side by side, never neither.
 *
 * @example
 * ```js
 * const result = await pullRelease({ config, apiKey, rootJwk });   // the SDK's PullBundleResult
 * const plan = planSeed({ result, config });                        // { files: [{ path, text, summary }], releaseJson, summary }
 * writeSeed({ outDir: "./prompts", plan });                         // refuses a directory that holds anything but a registry
 * ```
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SyncClient, pullBundle, trustedRootFromPinnedKey } from "@airprompter/agent-sdk";
import { fileFor } from "./promptFiles.mjs";

/**
 * What a registry directory may hold: the keep file, the dev keys, the golden sets, release.json, and tag-shaped
 * paths — a directory per tag segment, a `.md` per leaf (dots in a tag are directories, so a name holds none).
 */
const REGISTRY_ENTRY = /^(\.gitkeep|\.airprompter-dev|golden|release\.json|[a-z0-9]+(?:[_-][a-z0-9]+)*(?:\.md)?)$/;
/** Proof that a directory is a registry and not somebody's home: one of these must be present before anything goes. */
const MARKERS = new Set([".gitkeep", ".airprompter-dev"]);
const GOLDEN_ENTRY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\.json$/;
const KEPT = new Set([".gitkeep", ".airprompter-dev"]);
/** Finder and editors leave these; they are deleted with the stale files rather than refused. */
const NOISE = new Set([".DS_Store", "Thumbs.db"]);

function field(object, name, where) {
  const value = object?.[name];
  if (value === undefined || value === null) throw new Error(`${where}: the bundle carried no ${name} (the SDK's bundle shape changed; update scripts/lib/seed.mjs)`);
  return value;
}

/**
 * One plaintext pull of the environment's promoted release. Refuses a non-dev environment before any request (the
 * SDK writes plaintext for dev only). `pull` and `fetchImpl` are the SDK's and the platform's; a test passes fakes.
 */
export async function pullRelease({ config, apiKey, rootJwk, fetchImpl = globalThis.fetch, pull = pullBundle, now = () => new Date().toISOString() }) {
  if (config.environment !== "dev") throw new Error(`the seed pulls a plaintext bundle, which the SDK allows for dev only; ${config.environment} bundles are sealed to a fleet key — seed from dev`);
  if (!apiKey) throw new Error("an Agent key is required");
  if (rootJwk?.d !== undefined) throw new Error("the pinned root carries a private member; keys/ holds public JWKs only");
  const client = new SyncClient({ baseUrl: config.baseUrl, agentId: config.agentId, target: config.environment, apiKey, fetch: fetchImpl, userAgent: "zudocs-seed/0.1.0" });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: config.hostedEnvironment, pinnedRoot: { kty: "EC", crv: "P-256", x: rootJwk.x, y: rootJwk.y } });
  const fetchRoot = async () => {
    const response = await fetchImpl(config.rootUrl, { headers: { "user-agent": "zudocs-seed/0.1.0" } });
    return response.status === 200 ? response.json() : null;
  };
  return pull({ client, scope: { organizationId: config.organizationId, agentId: config.agentId, target: config.environment }, trustedRoot, fetchRoot, now, distributionPublicKey: null, skipPointer: true });
}

/** Why a pull gave no bundle, in words a developer can act on. */
function pullRefusal(result, environment) {
  if (result?.status === "nothing_promoted") return `${environment}: nothing is promoted yet`;
  if (result?.status === "unavailable" && result.reason === "unauthorized") return "the Agent key was not accepted (AIRPROMPTER_AGENT_KEY: the zudocs-support Agent's key for this environment)";
  if (result?.status === "unavailable") return `AirPrompter did not answer the pull: ${result.reason}${result.detail ? ` (${String(result.detail).slice(0, 200)})` : ""}`;
  if (result?.status === "refused") return `the SDK refused the release: ${result.reason}${result.detail ? ` (${String(result.detail).slice(0, 200)})` : ""}`;
  return `the pull answered ${JSON.stringify(result?.status ?? null)}, not a bundle`;
}

/** Every payload by content hash, its bytes decoded (base64url, as the SDK writes them) and hashed again. */
function payloadsOf(contents) {
  const out = new Map();
  for (const entry of field(contents, "payloads", "bundle")) {
    const bytes = Buffer.from(field(entry, "bytes", "payload"), "base64url");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (hash !== entry.contentHash || bytes.length !== entry.byteLength) throw new Error(`payload ${String(entry.contentHash).slice(0, 19)}…: the bytes do not hash to their content hash`);
    out.set(hash, bytes);
  }
  return out;
}

/** The files a verified plaintext bundle seeds: one per prompt slot, a golden set where one is pinned, release.json. Pure. */
export function planSeed({ result, config }) {
  if (result?.status !== "ok") throw new Error(pullRefusal(result, config.environment));
  const bundle = field(result, "bundle", "pull");
  if (bundle.encryption?.scheme !== "none") throw new Error(`the bundle is sealed (${bundle.encryption?.scheme}); the seed reads plaintext dev bundles only`);
  const contents = field(bundle.encryption, "contents", "bundle");
  const payload = field(field(contents, "manifest", "bundle"), "payload", "manifest");
  for (const [name, want] of [["organizationId", config.organizationId], ["agentId", config.agentId], ["target", config.environment]]) {
    if (payload[name] !== want) throw new Error(`the manifest's ${name} is ${JSON.stringify(payload[name])}, not ${JSON.stringify(want)}`);
  }
  const applyPolicy = field(payload, "applyPolicy", "manifest");
  const leaseSeconds = field(payload, "leaseSeconds", "manifest");
  if (applyPolicy !== "auto" && applyPolicy !== "unlock_required") throw new Error(`manifest.applyPolicy is ${JSON.stringify(applyPolicy)}, not auto or unlock_required`);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60) throw new Error(`manifest.leaseSeconds is ${JSON.stringify(leaseSeconds)}`);
  const payloads = payloadsOf(contents);
  const bytesOf = (hash, where) => {
    const bytes = payloads.get(hash);
    if (!bytes) throw new Error(`${where}: the bundle carries no payload ${String(hash).slice(0, 19)}…`);
    return bytes;
  };

  const slots = field(payload, "slots", "manifest");
  for (const slot of slots) {
    const kind = field(slot, "kind", `manifest.slots[${slot.tag ?? "?"}]`);
    if (kind !== "prompt" && kind !== "workflow") throw new Error(`manifest.slots[${slot.tag ?? "?"}]: kind ${JSON.stringify(kind)} is not prompt or workflow (update scripts/lib/seed.mjs)`);
  }
  const prompts = slots.filter((slot) => slot.kind === "prompt");
  const skipped = slots.filter((slot) => slot.kind !== "prompt").map((slot) => slot.tag);
  if (prompts.length === 0) throw new Error(`${config.environment}: the promoted release names no prompt slot (${slots.length} slots) — nothing to seed`);

  const files = [];
  for (const slot of prompts) {
    for (const name of ["tag", "versionId", "model", "contentHash"]) field(slot, name, `manifest.slots[${slot.tag ?? "?"}]`);
    const text = bytesOf(slot.contentHash, slot.tag).toString("utf8");
    // The slot's own block, in the wire's integers (temperatureMilli, topPBps): what the runtime applies.
    const file = fileFor({ tag: slot.tag, model: slot.model, versionId: slot.versionId, variables: slot.variables ?? [], checks: slot.outputChecks ?? [], inference: slot.inference ?? null, text });
    files.push({ ...file, summary: `${slot.tag} ${slot.versionId} ${slot.model} · ${slot.variables?.length ?? 0} variables · ${slot.outputChecks?.length ?? 0} checks · ${Buffer.byteLength(text, "utf8")} bytes` });
    if (slot.goldenSet) {
      // The set the release pinned, from the bundle itself: there is no later edit to drift from.
      const ref = slot.goldenSet;
      let set;
      try {
        set = JSON.parse(bytesOf(field(ref, "contentHash", `${slot.tag} goldenSet`), `${slot.tag} golden set`).toString("utf8"));
      } catch (error) {
        throw new Error(`${slot.tag}: the golden set payload is not JSON (${error.message.slice(0, 80)})`);
      }
      const cases = field(set, "cases", `${slot.tag} golden set`);
      const minPassBps = field(set, "minPassBps", `${slot.tag} golden set`);
      files.push({ path: `golden/${slot.tag}.json`, text: `${JSON.stringify(set, null, 2)}\n`, summary: `golden set ${set.setId ?? ref.setId}: ${cases.length} cases, floor ${minPassBps / 100}%` });
    }
  }
  const releaseJson = { applyPolicy, leaseSeconds, ...(payload.onLeaseExpiry ? { onLeaseExpiry: payload.onLeaseExpiry } : {}) };
  const experiments = (payload.experiments ?? (payload.experiment ? [payload.experiment] : [])).length;
  return {
    files,
    releaseJson,
    skipped,
    summary: `agent ${config.agentId} · ${config.environment} · generation ${payload.generation} · release ${String(payload.releaseDigest).slice(0, 19)}… · policy ${applyPolicy}${experiments ? ` · ${experiments} experiment(s): the control slots are seeded` : ""}`,
  };
}

/** A `release.json` counts as a marker only when it is this seed's own shape, not any file of that name. */
function isSeedReleaseJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return (parsed.applyPolicy === "auto" || parsed.applyPolicy === "unlock_required") && Number.isInteger(parsed.leaseSeconds);
  } catch {
    return false;
  }
}

/**
 * Everything under `dir` (the keep file and the dev keys excepted) must look like a registry: tag-shaped
 * directories and `.md` leaves, `golden/<tag>.json`, `release.json`; no symbolic link anywhere. Returns the
 * offending relative paths, so the caller can refuse before touching anything.
 */
function foreignEntries(dir, prefix = "") {
  const foreign = [];
  for (const entry of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if ((!prefix && KEPT.has(entry)) || NOISE.has(entry)) continue;
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { foreign.push(`${rel} (a symbolic link)`); continue; }
    const inGolden = prefix === "golden";
    const shape = inGolden ? GOLDEN_ENTRY.test(entry) && stat.isFile() : REGISTRY_ENTRY.test(entry) && (stat.isDirectory() ? !entry.endsWith(".md") && entry !== "release.json" : entry.endsWith(".md") || (!prefix && entry === "release.json"));
    if (!shape) { foreign.push(rel); continue; }
    if (stat.isDirectory() && !inGolden) foreign.push(...foreignEntries(path, rel));
  }
  return foreign;
}

/**
 * Write the plan into `outDir`: refuse anything that is not a registry, write the new files, then remove what the
 * plan no longer names — everything but the keep file and the dev keys.
 */
export function writeSeed({ outDir, plan }) {
  if (plan.files.length === 0) throw new Error("the plan names no files — refusing to write an empty registry");
  if (existsSync(outDir)) {
    if (lstatSync(outDir).isSymbolicLink()) throw new Error(`${outDir} is a symbolic link — refusing to write through it`);
    const entries = readdirSync(outDir).filter((entry) => !NOISE.has(entry));
    const marked = entries.some((entry) => MARKERS.has(entry) || (entry === "release.json" && isSeedReleaseJson(join(outDir, entry))));
    if (entries.length && !marked) throw new Error(`${outDir} is not empty and carries no registry marker (.gitkeep, .airprompter-dev, or a release.json this seed wrote) — refusing to replace it`);
    const foreign = foreignEntries(outDir);
    if (foreign.length) throw new Error(`${outDir} holds ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", …" : ""} — not a prompt registry, refusing to replace it (a README.md there would be served as a slot; keep docs outside the directory)`);
  }
  mkdirSync(outDir, { recursive: true });
  const written = new Set(["release.json"]);
  for (const file of plan.files) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
    written.add(file.path);
  }
  writeFileSync(join(outDir, "release.json"), `${JSON.stringify(plan.releaseJson, null, 2)}\n`);
  removeStale(outDir, "", written);
}

/** Every file not written this run goes (the keep file and the dev keys stay); a directory left empty goes with it. */
function removeStale(root, prefix, written) {
  const dir = join(root, prefix);
  for (const entry of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (!prefix && KEPT.has(entry)) continue;
    const path = join(root, rel);
    if (lstatSync(path).isDirectory()) {
      removeStale(root, rel, written);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
    } else if (!written.has(rel)) {
      rmSync(path, { force: true });
    }
  }
}
