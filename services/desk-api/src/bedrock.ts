/**
 * The model calls, two provider shapes on one platform, both observed by the SDK with no change at the call site:
 *
 * - **Luna** through Bedrock's OpenAI-compatible `bedrock-mantle` endpoint: an ordinary `openai` client under
 *   `ap.wrap()`. The client speaks the release's model name (`openai.gpt-5-6-luna`); the transport signs each
 *   request with SigV4 from the function's role (no provider key exists anywhere) and rewrites `model` to the id
 *   Bedrock takes (`openai.gpt-5.6-luna`). The wrapper attributes the call to the render whose text it carries,
 *   applies the version's inference settings (the output cap, the reasoning effort) and files the observation.
 * - **Nova Micro and Haiku 4.5** through Converse with the Vercel AI SDK's Bedrock provider under
 *   `ap.aiSdkMiddleware()`. The provider model is aliased to the release's name for the same reason: the
 *   middleware applies settings and files observations under the name the release pins.
 *
 * Nothing here retries (both clients at zero retries): a throttle or a refusal is observed once, as such, and
 * surfaces on the desk.
 *
 * @example
 * ```ts
 * const callers = createCallers(ap, "us-east-1");
 * const { text, response } = await callers.complete(rendered);          // the model's answer to the rendered prompt
 * const verdict = await callers.judge(judgePrompt);                    // the judge on Nova Micro, unattributed
 * ```
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { generateText, wrapLanguageModel, type LanguageModel } from "ai";
import OpenAI from "openai";
import type { AirPrompterAgent, Rendered } from "@airprompter/agent-sdk";
import { CATALOGUE, bedrockIdOf, entryOf } from "./modelCatalogue.js";

export interface Completion {
  text: string;
  /** The provider's answer, whole, for the caller that wants finish reason or usage (never logged). */
  response: unknown;
}

export interface Callers {
  complete(rendered: Pick<Rendered, "model" | "text">): Promise<Completion>;
  judge(prompt: string): Promise<string>;
  readonly judgeModel: string;
}

export const MANTLE_SERVICE = "bedrock-mantle";
export const mantleBaseUrl = (region: string): string => `https://bedrock-mantle.${region}.api.aws/v1`;

/** The catalogue name in an OpenAI-shaped body replaced by Bedrock's id; anything else untouched. Pure. */
export function rewriteMantleBody(body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (typeof parsed.model === "string" && CATALOGUE[parsed.model]) parsed.model = bedrockIdOf(parsed.model);
  return JSON.stringify(parsed);
}

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** SigV4 for the Mantle endpoint: the body rewritten, a minimal signed header set, the client's bearer dropped. */
export function mantleFetch(region: string, credentials = defaultProvider(), inner: FetchImpl = globalThis.fetch): FetchImpl {
  const signer = new SignatureV4({ service: MANTLE_SERVICE, region, credentials, sha256: Sha256 });
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "POST").toUpperCase();
    const body = typeof init?.body === "string" ? rewriteMantleBody(init.body) : undefined;
    const request = new HttpRequest({ protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams), method, headers: { host: url.hostname, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body });
    const signed = await signer.sign(request);
    const headers: Record<string, string> = { ...signed.headers };
    for (const [name, value] of new Headers(init?.headers ?? {}).entries()) {
      // The OpenAI client's bearer would shadow the signature; its diagnostic headers ride along unsigned.
      if (name === "authorization" || name === "content-type" || name === "host" || name === "content-length") continue;
      headers[name] = value;
    }
    return inner(url.href, { method, headers, body, ...(init?.signal ? { signal: init.signal } : {}) });
  };
}

/** The provider's model under the release's name: the middleware sees the catalogue id, the wire sees Bedrock's. */
export function aliasModel<M extends { modelId: string; doGenerate: (...args: any[]) => any; doStream: (...args: any[]) => any }>(inner: M, modelId: string): M {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "modelId") return modelId;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `choices[0].message.content` as text — a string, or the text parts of an array; empty when the model said nothing. */
export function textOfChat(response: unknown): string {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

export function createCallers(ap: AirPrompterAgent, region: string, options: { judgeModel?: string; fetch?: FetchImpl } = {}): Callers {
  const judgeModel = options.judgeModel ?? "amazon.nova-micro";
  entryOf(judgeModel);
  const openai = ap.wrap(new OpenAI({ baseURL: mantleBaseUrl(region), apiKey: "sigv4", fetch: options.fetch ?? mantleFetch(region), maxRetries: 0, timeout: 45_000 }));
  const bedrock = createAmazonBedrock({ region, credentialProvider: defaultProvider(), ...(options.fetch ? { fetch: options.fetch as any } : {}) });
  const converse = (model: string, observed: boolean): LanguageModel => {
    const inner = aliasModel(bedrock(bedrockIdOf(model)), model);
    return observed ? wrapLanguageModel({ model: inner, middleware: ap.aiSdkMiddleware() as any }) : inner;
  };
  return {
    judgeModel,
    async complete(rendered) {
      const entry = entryOf(rendered.model);
      if (entry.path === "mantle") {
        const response = await openai.chat.completions.create({ model: rendered.model, messages: [{ role: "user", content: rendered.text }] });
        return { text: textOfChat(response), response };
      }
      const result = await generateText({ model: converse(rendered.model, true), prompt: rendered.text, maxRetries: 0 });
      return { text: result.text, response: result.response };
    },
    async judge(prompt) {
      // The judge prompt is not a render, so the middleware passes it through unobserved; the score lands through ap.judge.
      const result = await generateText({ model: converse(judgeModel, false), prompt, maxOutputTokens: 400, temperature: 0, maxRetries: 0 });
      return result.text;
    },
  };
}
