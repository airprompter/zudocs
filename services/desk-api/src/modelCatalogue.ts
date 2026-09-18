/**
 * The models this host can call, named two ways: as AirPrompter's catalogue names them (the string a prompt version
 * is pinned to, what the heartbeat reports, what every observation is filed under) and as Bedrock in us-east-1
 * names the same model (an inference profile for Converse, the Mantle id for the OpenAI-shaped endpoint). The
 * release's name is the only one the application code ever writes; the transport translates.
 *
 * Luna goes through Bedrock's OpenAI-compatible `bedrock-mantle` endpoint — the only one with a live token quota
 * for GPT-5.6 in a fresh account (the cross-region profile starts at 0 TPM) — under the SDK's `wrap()` of an
 * OpenAI client. Nova 2 Lite, Nova Micro and Haiku 4.5 go through Converse with the Vercel AI SDK's Bedrock
 * provider under `aiSdkMiddleware()`. Luna is the intended model for the reply and escalation slots; while the
 * account's access to it is gated it stays in the catalogue (so a release pinned to it is accepted the day the
 * gate lifts) and those slots are pinned to Nova 2 Lite (`docs/PROMPTS.md`).
 *
 * @example
 * ```ts
 * bedrockIdOf("openai.gpt-5-6-luna");   // "openai.gpt-5.6-luna" (mantle)
 * bedrockIdOf("amazon.nova-2-lite");    // "us.amazon.nova-2-lite-v1:0" (converse)
 * MODELS;                               // the ids reported on the heartbeat, in the catalogue's spelling
 * ```
 */

export type ModelPath = "mantle" | "converse";

export interface CatalogueEntry {
  /** The id as Bedrock takes it on the path. */
  readonly bedrockId: string;
  /** The foundation model the IAM policy names (the profile's base). */
  readonly foundationModelId: string;
  readonly path: ModelPath;
  /** For the desk's cost line: USD per million input / output tokens (list, 2026-09). */
  readonly usdPerMillion: { readonly input: number; readonly output: number };
}

export const CATALOGUE: Readonly<Record<string, CatalogueEntry>> = Object.freeze({
  "openai.gpt-5-6-luna": { bedrockId: "openai.gpt-5.6-luna", foundationModelId: "openai.gpt-5.6-luna", path: "mantle", usdPerMillion: { input: 0.2, output: 1.2 } },
  "amazon.nova-2-lite": { bedrockId: "us.amazon.nova-2-lite-v1:0", foundationModelId: "amazon.nova-2-lite-v1:0", path: "converse", usdPerMillion: { input: 0.3, output: 2.5 } },
  "amazon.nova-micro": { bedrockId: "us.amazon.nova-micro-v1:0", foundationModelId: "amazon.nova-micro-v1:0", path: "converse", usdPerMillion: { input: 0.035, output: 0.14 } },
  "anthropic.claude-haiku-4-5": { bedrockId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", foundationModelId: "anthropic.claude-haiku-4-5-20251001-v1:0", path: "converse", usdPerMillion: { input: 1, output: 5 } },
});

/** What this application reports it can call — the catalogue's spelling, the one a release pins. */
export const MODELS: readonly string[] = Object.freeze(Object.keys(CATALOGUE));

export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`this host cannot call ${model}: it reports ${MODELS.join(", ")} and a release pinned to anything else is refused before it activates`);
    this.name = "UnknownModelError";
  }
}

export function entryOf(model: string): CatalogueEntry {
  const entry = CATALOGUE[model];
  if (!entry) throw new UnknownModelError(model);
  return entry;
}

export function bedrockIdOf(model: string): string {
  return entryOf(model).bedrockId;
}

/** The catalogue name for a Bedrock id, when one of ours (the reverse map, for a response that names the wire's id). */
export function catalogueNameOf(bedrockId: string): string | null {
  for (const [name, entry] of Object.entries(CATALOGUE)) if (entry.bedrockId === bedrockId) return name;
  return null;
}

/** USD for one call at list price, from reported tokens; null when the usage was not reported. */
export function costUsd(model: string, tokens: { input?: number; cachedInput?: number; output?: number } | undefined, usageSource: string | undefined): number | null {
  const entry = CATALOGUE[model];
  if (!entry || !tokens || usageSource !== "reported") return null;
  const input = (tokens.input ?? 0) + (tokens.cachedInput ?? 0);
  return (input * entry.usdPerMillion.input + (tokens.output ?? 0) * entry.usdPerMillion.output) / 1_000_000;
}
