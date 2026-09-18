/**
 * The seed as two pure steps: `planSeed` reads the environment's promoted release from AirPrompter through a
 * caller-supplied `api(path)` and returns every file to write; `writeSeed` replaces a registry directory with that
 * plan. Split so the plan can be tested against a fake API and the write against a temporary directory, and so
 * nothing is written until every read succeeded.
 *
 * The routes read are the console's workspace API (`…/board`, `…/releases/{env}/{digest}`,
 * `/team/prompts/{id}/versions/{v}`, `…/slots/{tag}/golden`) — what the app's own pages call, with no
 * compatibility promise of their own — so every field this depends on is checked by name and a rename fails here,
 * not as a corrupt file.
 *
 * The write replaces a registry, never an arbitrary directory: a non-empty target must carry a registry marker
 * (`.gitkeep`, `.airprompter-dev/`, or a `release.json` of this seed's own shape), hold nothing but registry-shaped
 * entries at every depth, and contain no symbolic link. New files are written before stale ones are removed, so a
 * failure part-way leaves old and new side by side, never neither.
 *
 * @example
 * ```js
 * const plan = await planSeed({ api, config });          // { files: [{ path, text, summary }], releaseJson, summary }
 * writeSeed({ outDir: "./prompts", plan });              // refuses a directory that holds anything but a registry
 * ```
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function field(object, name, where, meaning = "the console API changed; update scripts/lib/seed.mjs") {
  const value = object?.[name];
  if (value === undefined || value === null) throw new Error(`${where}: the response carried no ${name} (${meaning})`);
  return value;
}

export async function planSeed({ api, config }) {
  const agentPath = `/workspace/${config.workspaceId}/agents/${config.agentId}`;
  const board = field(await api(`${agentPath}/board`), "board", "board");
  const environment = field(field(board, "environments", "board"), config.environment, "board.environments");
  if (!environment.releaseDigest) throw new Error(`${config.environment}: nothing is promoted yet (generation ${environment.generation ?? 0})`);
  const policy = field(environment, "policy", `board.environments.${config.environment}`, "the environment has no policy record yet: open it in the console once, or promote again");
  const applyPolicy = field(policy, "applyPolicy", "policy");
  const leaseSeconds = field(policy, "leaseSeconds", "policy");
  if (applyPolicy !== "auto" && applyPolicy !== "unlock_required") throw new Error(`policy.applyPolicy is ${JSON.stringify(applyPolicy)}, not auto or unlock_required`);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60) throw new Error(`policy.leaseSeconds is ${JSON.stringify(leaseSeconds)}`);

  const release = field(await api(`${agentPath}/releases/${config.environment}/${environment.releaseDigest}`), "release", "release");
  const pins = field(release, "pins", "release");
  const prompts = pins.filter((pin) => pin.kind === "prompt");
  const skipped = pins.filter((pin) => pin.kind !== "prompt").map((pin) => pin.tag);

  const files = [];
  for (const pin of pins) {
    const kind = field(pin, "kind", `release.pins[${pin.tag ?? "?"}]`);
    if (kind !== "prompt" && kind !== "workflow") throw new Error(`release.pins[${pin.tag ?? "?"}]: kind ${JSON.stringify(kind)} is not prompt or workflow (the console API changed; update scripts/lib/seed.mjs)`);
  }
  if (prompts.length === 0) throw new Error(`${config.environment}: the promoted release names no prompt slot (${pins.length} pins) — nothing to seed`);
  for (const pin of prompts) {
    for (const name of ["tag", "artifactId", "versionId", "model"]) field(pin, name, `release.pins[${pin.tag ?? "?"}]`);
    const version = await api(`/team/prompts/${pin.artifactId}/versions/${pin.versionId}`);
    const content = field(version, "content", `${pin.tag} ${pin.versionId}`);
    if (typeof content !== "string") throw new Error(`${pin.tag}: the version's content is not text`);
    // The pin's own block, in the wire's integers (temperatureMilli, topPBps): what the runtime applies.
    const file = fileFor({ tag: pin.tag, model: pin.model, versionId: pin.versionId, variables: pin.variables ?? [], checks: pin.outputChecks ?? [], inference: pin.inference ?? null, text: content });
    files.push({ ...file, summary: `${pin.tag} ${pin.versionId} ${pin.model} · ${pin.variables?.length ?? 0} variables · ${pin.outputChecks?.length ?? 0} checks · ${Buffer.byteLength(content, "utf8")} bytes` });
    if (pin.goldenSet) {
      // The slot's current set, checked against what the release pinned: an edit after the seal is not the pin.
      const golden = await api(`${agentPath}/slots/${pin.tag}/golden`);
      const set = field(golden, "set", `${pin.tag} golden`, "the slot's golden set was removed after this release was sealed; seal and promote again");
      const ref = field(golden, "ref", `${pin.tag} golden`);
      const pinnedHash = field(pin.goldenSet, "contentHash", `${pin.tag} goldenSet`);
      if (field(ref, "contentHash", `${pin.tag} golden ref`) !== pinnedHash) throw new Error(`${pin.tag}: the slot's golden set (${ref.setId}) is not the one the release pinned (${pin.goldenSet.setId}); seal and promote again, or seed after reverting the edit`);
      const cases = field(set, "cases", `${pin.tag} golden set`);
      const minPassBps = field(set, "minPassBps", `${pin.tag} golden set`);
      files.push({ path: `golden/${pin.tag}.json`, text: `${JSON.stringify(set, null, 2)}\n`, summary: `golden set ${set.setId}: ${cases.length} cases, floor ${minPassBps / 100}%` });
    }
  }
  const releaseJson = { applyPolicy, leaseSeconds, ...(policy.onLeaseExpiry ? { onLeaseExpiry: policy.onLeaseExpiry } : {}) };
  return {
    files,
    releaseJson,
    skipped,
    summary: `agent ${config.agentId} · ${config.environment} · generation ${environment.generation} · release ${String(environment.releaseDigest).slice(0, 19)}… · policy ${applyPolicy}`,
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
