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
  config.models = env.AIRPROMPTER_MODELS ? env.AIRPROMPTER_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : file.models ?? [];
  if (!Array.isArray(config.models) || config.models.length === 0) throw new Error("config: models is empty (the models this application can call, as the provider names them)");
  for (const key of ["environment", "hostedEnvironment"]) if (!["dev", "staging", "prod"].includes(config[key])) throw new Error(`config: ${key} must be dev, staging or prod`);
  return Object.freeze(config);
}

/** A secret from the environment: the value, or an error naming the variable and where the value comes from. */
export function secretFromEnv(name, whatItIs, env = process.env) {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`${name} is not set — export ${whatItIs} into the environment (never on a command line, never in git)`);
  return value.trim();
}
