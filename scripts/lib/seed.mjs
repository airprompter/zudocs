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
 * @example
 * ```js
 * const plan = await planSeed({ api, config });          // { files: [{ path, text, summary }], releaseJson, summary }
 * writeSeed({ outDir: "./prompts", plan });              // refuses a directory that holds anything but a registry
 * ```
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileFor } from "./promptFiles.mjs";

/**
 * What a registry directory may hold: the keep file, the dev keys, the golden sets, release.json, and tag-shaped
 * paths — a directory per tag segment, a `.md` per leaf (dots in a tag are directories, so a name holds none).
 */
const REGISTRY_ENTRY = /^(\.gitkeep|\.airprompter-dev|golden|release\.json|[a-z0-9]+(?:[_-][a-z0-9]+)*(?:\.md)?)$/;
const NEVER_A_REGISTRY = new Set(["node_modules", ".git"]);
const KEPT = new Set([".gitkeep", ".airprompter-dev"]);

function field(object, name, where) {
  const value = object?.[name];
  if (value === undefined || value === null) throw new Error(`${where}: the response carried no ${name} (the console API changed; update scripts/lib/seed.mjs)`);
  return value;
}

export async function planSeed({ api, config }) {
  const agentPath = `/workspace/${config.workspaceId}/agents/${config.agentId}`;
  const board = field(await api(`${agentPath}/board`), "board", "board");
  const environment = field(field(board, "environments", "board"), config.environment, "board.environments");
  if (!environment.releaseDigest) throw new Error(`${config.environment}: nothing is promoted yet (generation ${environment.generation ?? 0})`);
  const policy = field(environment, "policy", `board.environments.${config.environment}`);
  const applyPolicy = field(policy, "applyPolicy", "policy");
  const leaseSeconds = field(policy, "leaseSeconds", "policy");
  if (applyPolicy !== "auto" && applyPolicy !== "unlock_required") throw new Error(`policy.applyPolicy is ${JSON.stringify(applyPolicy)}, not auto or unlock_required`);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60) throw new Error(`policy.leaseSeconds is ${JSON.stringify(leaseSeconds)}`);

  const release = field(await api(`${agentPath}/releases/${config.environment}/${environment.releaseDigest}`), "release", "release");
  const pins = field(release, "pins", "release");
  const prompts = pins.filter((pin) => pin.kind === "prompt");
  const skipped = pins.filter((pin) => pin.kind !== "prompt").map((pin) => pin.tag);

  const files = [];
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
      const set = field(golden, "set", `${pin.tag} golden`);
      const ref = field(golden, "ref", `${pin.tag} golden`);
      if (ref.contentHash !== pin.goldenSet.contentHash) throw new Error(`${pin.tag}: the slot's golden set (${ref.setId}) is not the one the release pinned (${pin.goldenSet.setId}); seal and promote again, or seed after reverting the edit`);
      files.push({ path: `golden/${pin.tag}.json`, text: `${JSON.stringify(set, null, 2)}\n`, summary: `golden set ${set.setId}: ${set.cases.length} cases, floor ${set.minPassBps / 100}%` });
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

/** Everything in `outDir` but the keep file and the dev keys goes; the plan's files and release.json are written. */
export function writeSeed({ outDir, plan }) {
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    const foreign = entries.filter((entry) => NEVER_A_REGISTRY.has(entry) || !REGISTRY_ENTRY.test(entry));
    if (foreign.length) throw new Error(`${outDir} holds ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", …" : ""} — not a prompt registry, refusing to replace it (a README.md there would be served as a slot; keep docs outside the directory)`);
    for (const entry of entries) if (!KEPT.has(entry)) rmSync(join(outDir, entry), { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  for (const file of plan.files) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
  }
  writeFileSync(join(outDir, "release.json"), `${JSON.stringify(plan.releaseJson, null, 2)}\n`);
}
