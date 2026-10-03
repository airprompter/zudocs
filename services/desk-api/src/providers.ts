/**
 * The direct providers (phase 9): the same rendered prompt asked of the **OpenAI API** or the **Claude API** with a key
 * of the customer's own, beside the release's model on Bedrock and AirPrompter's hosted route. The point on the desk is
 * that the call site does not change shape: an ordinary `openai` or `@anthropic-ai/sdk` client under `ap.wrap()`, the
 * request carrying the render's text, the observation filed against the render — latency, tokens, usage source, the
 * checks — under the model the call actually named. The SDK files it under the request's model, not the release's,
 * and logs `wrap_inference_model_mismatch` once: the release's settings belong to its pinned model, so this module
 * applies them itself, in the units each provider takes, and the record says which were applied and which the
 * provider does not take (a reasoning model takes no temperature).
 *
 * A key is read by NAME from an SSM SecureString the first time its provider is asked for, held in memory, never
 * logged; a provider whose parameter the deployment does not name is honestly "not configured" (501 on the desk).
 * Nothing retries (both clients at zero retries): a refusal or a throttle is observed once, as such.
 *
 * @example
 * ```ts
 * const direct = createDirectCallers(ap, env.providers, env.region);
 * const { text, applied } = await direct.anthropic!.complete(rendered);   // Claude, the release's output cap applied
 * costUsdDirect("anthropic", env.providers.anthropic.model, observation.tokens, "reported");
 * ```
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AirPrompterAgent, Rendered } from "@airprompter/agent-sdk";
import { inferenceSettings, textOfChat, type Completion } from "./bedrock.js";

export type DirectProvider = "openai" | "anthropic";
export const DIRECT_PROVIDERS: readonly DirectProvider[] = Object.freeze(["openai", "anthropic"]);

export interface DirectProviderConfig {
  /** The SSM SecureString parameter NAME the provider key is read from; empty when the deployment names none. */
  readonly keyParameter: string;
  /** The provider's own model id — what the request names and the observation is filed under. */
  readonly model: string;
}

export type DirectProvidersConfig = Readonly<Record<DirectProvider, DirectProviderConfig>>;

/** List price (USD per million tokens, 2026-09) for the models this deployment may name on each provider. */
export const DIRECT_PRICES: Readonly<Record<DirectProvider, Readonly<Record<string, { readonly input: number; readonly output: number }>>>> = Object.freeze({
  openai: Object.freeze({
    "gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "gpt-5.6-terra": { input: 2, output: 12 },
    "gpt-5.6-sol": { input: 5, output: 30 },
  }),
  anthropic: Object.freeze({
    "claude-opus-5": { input: 5, output: 25 },
    "claude-sonnet-5": { input: 2, output: 10 },
    "claude-haiku-4-5": { input: 1, output: 5 },
  }),
});

/** The provider's label for the desk and the docs. */
export const PROVIDER_LABEL: Readonly<Record<DirectProvider, string>> = Object.freeze({ openai: "OpenAI API", anthropic: "Claude API" });

/** USD for one call at list price, from reported tokens; null when the usage was not reported or the model is not priced here. */
export function costUsdDirect(provider: DirectProvider, model: string, tokens: { input?: number; cachedInput?: number; output?: number } | undefined, usageSource: string | undefined): number | null {
  const price = DIRECT_PRICES[provider][model];
  if (!price || !tokens || usageSource !== "reported") return null;
  return ((tokens.input ?? 0) + (tokens.cachedInput ?? 0)) * price.input / 1_000_000 + (tokens.output ?? 0) * price.output / 1_000_000;
}

/** Whether the deployment names a key parameter for the provider: without one, the provider is honestly "not configured". */
export function providerConfigured(config: DirectProvidersConfig, provider: DirectProvider): boolean {
  return config[provider].keyParameter !== "";
}

/** The release's settings as this provider takes them, and the ones it does not. Pure. */
export function settingsFor(provider: DirectProvider, model: string, inference: Rendered["inference"] | undefined): { applied: Record<string, number>; ignored: string[] } {
  const settings = inferenceSettings(inference);
  const applied: Record<string, number> = {};
  const ignored: string[] = [];
  if (settings.maxOutputTokens !== undefined) applied[provider === "openai" ? "max_completion_tokens" : "max_tokens"] = settings.maxOutputTokens;
  if (settings.temperature !== undefined) {
    // A reasoning model takes no temperature: GPT-5.6 on the OpenAI API, Claude 4.6 and later on the Claude API refuse it.
    const takesTemperature = provider === "openai" ? !model.startsWith("gpt-5") : /^claude-(haiku-4-5|sonnet-4-5|opus-4-[0-5]|3)/.test(model);
    if (takesTemperature) applied.temperature = settings.temperature;
    else ignored.push("temperature");
  }
  return { applied, ignored };
}

export interface DirectCompletion extends Completion {
  provider: DirectProvider;
  model: string;
  /** The release's settings applied on this request, in the provider's names; the ones the provider does not take. */
  applied: Record<string, number>;
  ignored: string[];
}

export interface DirectCaller {
  readonly provider: DirectProvider;
  readonly model: string;
  complete(rendered: Pick<Rendered, "model" | "text" | "inference">): Promise<DirectCompletion>;
}

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DirectOptions {
  fetch?: FetchImpl;
  /** The secret reader (SSM by default); a fake in tests. */
  readSecret?: (name: string) => Promise<string>;
}

async function readFromSsm(region: string, name: string): Promise<string> {
  const out = await new SSMClient({ region }).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`the SSM parameter ${name} has no value`);
  return value;
}

/** The text of a Claude message: its text blocks joined; empty when the model said nothing (or only thought). */
export function textOfMessage(response: unknown): string {
  const content = (response as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

/** One caller per configured provider; null for a provider the deployment names no key parameter for. */
export function createDirectCallers(ap: AirPrompterAgent, config: DirectProvidersConfig, region: string, options: DirectOptions = {}): Readonly<Record<DirectProvider, DirectCaller | null>> {
  const readSecret = options.readSecret ?? ((name: string) => readFromSsm(region, name));
  const keyOf = (provider: DirectProvider): (() => Promise<string>) => {
    let key: Promise<string> | null = null;
    return () => {
      if (!key) {
        key = readSecret(config[provider].keyParameter).catch((error) => {
          key = null;
          throw new Error(`the SSM parameter ${config[provider].keyParameter} could not be read (${(error as Error).name}): the owner writes the ${PROVIDER_LABEL[provider]} key there (RUNBOOK.md › Keys)`);
        });
      }
      return key;
    };
  };
  const fetchOption = options.fetch ? { fetch: options.fetch as never } : {};

  const openaiCaller = (): DirectCaller => {
    const { model } = config.openai;
    const key = keyOf("openai");
    let client: Promise<OpenAI> | null = null;
    const clientOf = () => (client ??= key().then((apiKey) => ap.wrap(new OpenAI({ apiKey, maxRetries: 0, timeout: 45_000, ...fetchOption }))).catch((error) => { client = null; throw error; }));
    return {
      provider: "openai",
      model,
      async complete(rendered) {
        const { applied, ignored } = settingsFor("openai", model, rendered.inference);
        const openai = await clientOf();
        const response = await openai.chat.completions.create({ model, messages: [{ role: "user", content: rendered.text }], ...applied });
        return { text: textOfChat(response), response, provider: "openai", model, applied, ignored };
      },
    };
  };

  const anthropicCaller = (): DirectCaller => {
    const { model } = config.anthropic;
    const key = keyOf("anthropic");
    let client: Promise<Anthropic> | null = null;
    const clientOf = () => (client ??= key().then((apiKey) => ap.wrap(new Anthropic({ apiKey, maxRetries: 0, timeout: 45_000, ...fetchOption }))).catch((error) => { client = null; throw error; }));
    return {
      provider: "anthropic",
      model,
      async complete(rendered) {
        const { applied, ignored } = settingsFor("anthropic", model, rendered.inference);
        const anthropic = await clientOf();
        // A support reply, not a long document: the release's output cap when it has one, a modest one otherwise.
        const { max_tokens = 1024, ...rest } = applied;
        const response = await anthropic.messages.create({ model, max_tokens, messages: [{ role: "user", content: rendered.text }], ...rest });
        return { text: textOfMessage(response), response, provider: "anthropic", model, applied: { max_tokens, ...rest }, ignored };
      },
    };
  };

  return Object.freeze({
    openai: providerConfigured(config, "openai") ? openaiCaller() : null,
    anthropic: providerConfigured(config, "anthropic") ? anthropicCaller() : null,
  });
}
