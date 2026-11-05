/**
 * Reads this agent's configuration from the environment and refuses to start without what it needs.
 *
 * Identifiers and the provider-model name are plain values. The Agent key and the provider key reach the process
 * through the environment only, and nothing here prints either one.
 *
 * @example
 * ```ts
 * const config = readConfig(process.env); // throws naming the missing variables, never their values
 * ```
 */

import { readFileSync } from "node:fs";

export interface AgentConfig {
  organizationId: string;
  agentId: string;
  apiKey: string;
  target: "dev" | "staging" | "prod";
  baseUrl: string;
  rootJwk: ReturnType<typeof JSON.parse>;
  rootUrl?: string;
  stateDir: string;
  /** The model this app calls while nothing is approved, as LangChain names it: `openai:gpt-5.4-mini`. */
  fallbackModel: string;
  /** What this process reports to AirPrompter so a seal can pin it. ZUDOCS_EXTRA_MODELS adds the other slots' models. */
  models: string[];
  slot: string;
}

const REQUIRED = ["AIRPROMPTER_ORG_ID", "AIRPROMPTER_AGENT_ID", "AIRPROMPTER_AGENT_KEY", "AIRPROMPTER_ROOT_JWK_FILE"] as const;

export function readConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing from the environment: ${missing.join(", ")}`);
  const target = env.AIRPROMPTER_TARGET ?? "dev";
  if (target !== "dev" && target !== "staging" && target !== "prod") throw new Error(`AIRPROMPTER_TARGET must be dev, staging or prod, not ${target}`);
  const fallbackModel = env.ZUDOCS_MODEL ?? "openai:gpt-5.4-mini";
  return {
    organizationId: env.AIRPROMPTER_ORG_ID!,
    agentId: env.AIRPROMPTER_AGENT_ID!,
    apiKey: env.AIRPROMPTER_AGENT_KEY!,
    target,
    baseUrl: env.AIRPROMPTER_BASE_URL ?? "https://api-dev.airprompter.com",
    rootJwk: JSON.parse(readFileSync(env.AIRPROMPTER_ROOT_JWK_FILE!, "utf8")),
    ...(env.AIRPROMPTER_ROOT_URL ? { rootUrl: env.AIRPROMPTER_ROOT_URL } : {}),
    stateDir: env.ZUDOCS_STATE_DIR ?? "../../state/langchain/runtime",
    fallbackModel,
    models: [fallbackModel.split(":").pop()!, ...(env.ZUDOCS_EXTRA_MODELS ?? "").split(",").filter(Boolean)],
    slot: env.ZUDOCS_SLOT ?? "support-agent",
  };
}
