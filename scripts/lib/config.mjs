/**
 * Where the prompts live in AirPrompter and how a script reaches them: the identifiers from `airprompter.config.json`
 * (an environment variable of the same name in upper snake case overrides each — `AIRPROMPTER_BASE_URL`,
 * `AIRPROMPTER_AGENT_ID`, …) and the secrets from the environment only. Nothing here prints a secret; a missing one
 * is named, never echoed.
 *
 * @example
 * ```js
 * import { readConfig, secretFromEnv } from "./lib/config.mjs";
 * const config = readConfig();                                  // { baseUrl, organizationId, agentId, environment, … }
 * const key = secretFromEnv("AIRPROMPTER_AGENT_KEY", "an Agent key from Settings › Keys");
 * ```
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const KEYS = ["baseUrl", "hostedEnvironment", "rootUrl", "organizationId", "workspaceId", "agentId", "environment"];

export function readConfig(env = process.env) {
  const file = JSON.parse(readFileSync(join(repoRoot, "airprompter.config.json"), "utf8"));
  const config = {};
  for (const key of KEYS) {
    const envName = `AIRPROMPTER_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const value = env[envName] ?? file[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`config: ${key} is missing (airprompter.config.json or ${envName})`);
    config[key] = value.trim();
  }
  // The environment's edge pointer (`…/g/<token>/generation.json`): optional, an identifier — a resident host idles on it.
  const pointer = env.AIRPROMPTER_EDGE_POINTER_URL ?? file.edgePointerUrl ?? "";
  config.edgePointerUrl = typeof pointer === "string" && pointer.trim() ? pointer.trim() : null;
  config.models = env.AIRPROMPTER_MODELS ? env.AIRPROMPTER_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : file.models ?? [];
  if (!Array.isArray(config.models) || config.models.length === 0) throw new Error("config: models is empty (the models this application can call, as the provider names them)");
  for (const key of ["environment", "hostedEnvironment"]) if (!["dev", "staging", "prod"].includes(config[key])) throw new Error(`config: ${key} must be dev, staging or prod`);
  // Phase 6: hosted staging (the run route's origin, an identifier), the CI vendoring agent, and the canonical pins the reset advances from.
  const runUrl = env.AIRPROMPTER_HOSTED_RUN_URL ?? file.hostedRunUrl ?? "";
  config.hostedRunUrl = typeof runUrl === "string" && runUrl.trim() ? runUrl.trim() : null;
  config.hostedTarget = typeof file.hostedTarget === "string" && file.hostedTarget.trim() ? file.hostedTarget.trim() : "staging";
  if (!["dev", "staging", "prod"].includes(config.hostedTarget)) throw new Error("config: hostedTarget must be dev, staging or prod");
  config.ciAgentId = typeof file.ciAgentId === "string" && file.ciAgentId.trim() ? file.ciAgentId.trim() : null;
  const canonical = typeof file.canonical === "object" && file.canonical !== null ? file.canonical : {};
  config.canonical = Object.freeze(Object.fromEntries(Object.entries(canonical).filter(([tag]) => !tag.startsWith("$")).map(([tag, pin]) => {
    if (typeof pin?.versionId !== "string" || typeof pin?.model !== "string") throw new Error(`config: canonical.${tag} needs versionId and model`);
    return [tag, Object.freeze({ versionId: pin.versionId, model: pin.model })];
  })));
  return Object.freeze(config);
}

/** A secret from the environment: the value, or an error naming the variable and where the value comes from. */
export function secretFromEnv(name, whatItIs, env = process.env) {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`${name} is not set — export ${whatItIs} into the environment (never on a command line, never in git)`);
  return value.trim();
}
