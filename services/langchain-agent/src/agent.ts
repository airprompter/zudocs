/**
 * The Zudocs support agent: a LangChain `createAgent` whose system text and model come from AirPrompter.
 *
 * The AirPrompter part is one entry in `middleware`, listed last. This file holds no prompt text: until a release is
 * promoted the agent runs on its own model with no system text, and the middleware writes nothing.
 *
 * @example
 * ```ts
 * const ap = await startRuntime(config, console.log);
 * const agent = buildAgent(ap, config);
 * const outcome = await ask(agent, "Can northwind export to PDF?", "northwind");
 * ```
 */

import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { airprompter } from "@airprompter/agent-sdk/frameworks/langchain";
import { AIMessage, HumanMessage, createAgent } from "langchain";

import type { AgentConfig } from "./config.js";
import { getCustomerPlan, searchDocs } from "./tools.js";

/** Counts only: this app never prints prompt text or a model's answer. */
export interface Outcome {
  modelCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  /** True when the reply closes with the sign-off version 2 asks for, which tells the two versions apart. */
  signed: boolean;
}

export function startRuntime(config: AgentConfig, log: (line: string) => void): Promise<AirPrompterAgent> {
  return AirPrompterAgent.start({
    organizationId: config.organizationId,
    agentId: config.agentId,
    target: config.target,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    stateDir: config.stateDir,
    root: { pinned: config.rootJwk, hostedEnvironment: config.target },
    sync: { mode: "resident", pollSeconds: 15, ...(config.rootUrl ? { rootUrl: config.rootUrl } : {}) },
    models: config.models,
    heartbeatSeconds: 60,
    logger: (event) => {
      if (event.event !== "heartbeat") log(`sdk: ${JSON.stringify(event)}`);
    },
  });
}

export function buildAgent(ap: AirPrompterAgent, config: AgentConfig) {
  return createAgent({
    model: config.fallbackModel,
    tools: [searchDocs, getCustomerPlan],
    middleware: [airprompter(ap, { slots: config.slot })], // last in the list
  });
}

/** A reply's text: LangChain gives a plain string or, on OpenAI's Responses API, a list of content blocks. */
function replyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
}

export function summarise(messages: readonly unknown[], ms: number): Outcome {
  const replies = messages.filter(AIMessage.isInstance);
  const last = replies.at(-1);
  return {
    modelCalls: replies.length,
    toolCalls: replies.reduce((sum, reply) => sum + (reply.tool_calls?.length ?? 0), 0),
    tokensIn: replies.reduce((sum, reply) => sum + (reply.usage_metadata?.input_tokens ?? 0), 0),
    tokensOut: replies.reduce((sum, reply) => sum + (reply.usage_metadata?.output_tokens ?? 0), 0),
    ms,
    signed: /zudocs support\W*$/i.test(replyText(last?.content)),
  };
}

export async function ask(agent: ReturnType<typeof buildAgent>, question: string, customer: string, subject = customer): Promise<Outcome> {
  const started = Date.now();
  const result = await agent.invoke(
    { messages: [new HumanMessage(`I am writing for ${customer}. ${question}`)] },
    { context: { airprompter: { subject } } },
  );
  return summarise(result.messages, Date.now() - started);
}
