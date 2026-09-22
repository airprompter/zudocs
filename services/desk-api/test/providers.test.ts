/**
 * The provider switch (phase 9): the release's settings land on each API in its own names and a reasoning model's
 * refusal of temperature is said, not sent; the price is the provider's list and null when usage was not reported;
 * the callers put the render's text in the request (what `ap.wrap()` attributes by), read the key by NAME once and
 * never write it anywhere; the handler sends the reply where it was asked, answers 501 for a provider the deployment
 * names no key for, 400 for one it has never heard of, and the record names the route.
 *
 * @example
 * ```sh
 * npx tsx --test test/providers.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readEnv } from "../src/env.js";
import { costUsdDirect, createDirectCallers, providerConfigured, settingsFor, textOfMessage, type DirectProvidersConfig } from "../src/providers.js";

const config: DirectProvidersConfig = { openai: { keyParameter: "/zudocs/dev/openai-key", model: "gpt-5.6-luna" }, anthropic: { keyParameter: "/zudocs/dev/anthropic-key", model: "claude-opus-5" } };
const rendered = { model: "amazon.nova-2-lite", text: "support.reply: <ticket>the ticket text</ticket>", inference: { temperatureMilli: 300, maxOutputTokens: 600 } as never };

/** A wrap() that records what it was handed and forwards the client untouched: the test reads the request off the fetch. */
const fakeAp = (wrapped: unknown[]) => ({ wrap: <T,>(client: T): T => { wrapped.push(client); return client; } }) as never;

test("settings: the output cap in each provider's name; temperature only where the model takes it, otherwise said as ignored", () => {
  assert.deepEqual(settingsFor("openai", "gpt-5.6-luna", rendered.inference), { applied: { max_completion_tokens: 600 }, ignored: ["temperature"] });
  assert.deepEqual(settingsFor("anthropic", "claude-opus-5", rendered.inference), { applied: { max_tokens: 600 }, ignored: ["temperature"] });
  assert.deepEqual(settingsFor("anthropic", "claude-haiku-4-5", rendered.inference), { applied: { max_tokens: 600, temperature: 0.3 }, ignored: [] });
  assert.deepEqual(settingsFor("openai", "gpt-4.1-mini", rendered.inference), { applied: { max_completion_tokens: 600, temperature: 0.3 }, ignored: [] });
  assert.deepEqual(settingsFor("openai", "gpt-5.6-luna", undefined), { applied: {}, ignored: [] });
});

test("price: the provider's list from reported tokens; null when usage was measured or the model is not priced", () => {
  assert.equal(costUsdDirect("openai", "gpt-5.6-luna", { input: 1_000_000, output: 1_000_000 }, "reported"), 1.4);
  assert.equal(costUsdDirect("anthropic", "claude-opus-5", { input: 200, cachedInput: 100, output: 40 }, "reported"), (300 * 5 + 40 * 25) / 1_000_000);
  assert.equal(costUsdDirect("anthropic", "claude-opus-5", { input: 200, output: 40 }, "measured"), null);
  assert.equal(costUsdDirect("openai", "gpt-9", { input: 1, output: 1 }, "reported"), null);
  assert.equal(textOfMessage({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Hello" }, { type: "text", text: " there" }] }), "Hello there");
  assert.equal(textOfMessage({ content: "nope" }), "");
});

test("configured: a provider without a key parameter is null on the host and false on the features; readEnv refuses a value that looks like a key", () => {
  assert.equal(providerConfigured(config, "openai"), true);
  assert.equal(providerConfigured({ ...config, anthropic: { keyParameter: "", model: "x" } }, "anthropic"), false);
  const callers = createDirectCallers(fakeAp([]), { ...config, anthropic: { keyParameter: "", model: "x" } }, "us-east-1", { readSecret: async () => "k" });
  assert.ok(callers.openai);
  assert.equal(callers.anthropic, null);
  const base = { TICKETS_TABLE: "t", CUSTOMERS_TABLE: "c", RUNS_TABLE: "r", FEEDBACK_TABLE: "f", STATUS_TABLE: "s", EVENTS_TABLE: "e", COUNTERS_TABLE: "n", APPROVALS_TABLE: "a", KMS_KEY_ID: "k", AGENT_KEY_PARAMETER: "/p", DAILY_RUN_CAP: "5", STATE_EPOCH: "1", AIRPROMPTER_BASE_URL: "u", AIRPROMPTER_ORGANIZATION_ID: "o", AIRPROMPTER_AGENT_ID: "a", AIRPROMPTER_ENVIRONMENT: "dev", AIRPROMPTER_HOSTED_ENVIRONMENT: "dev", AIRPROMPTER_ROOT_URL: "r", AIRPROMPTER_ROOT_JWK: "{}" };
  assert.deepEqual(readEnv(base).providers, { openai: { keyParameter: "", model: "gpt-5.6-luna" }, anthropic: { keyParameter: "", model: "claude-opus-5" } });
  assert.deepEqual(readEnv({ ...base, OPENAI_KEY_PARAMETER: "/zudocs/dev/openai-key", ANTHROPIC_MODEL: "claude-haiku-4-5" }).providers, { openai: { keyParameter: "/zudocs/dev/openai-key", model: "gpt-5.6-luna" }, anthropic: { keyParameter: "", model: "claude-haiku-4-5" } });
  assert.throws(() => readEnv({ ...base, ANTHROPIC_KEY_PARAMETER: "sk-ant-abc" }), /looks like a key/);
  assert.throws(() => readEnv({ ...base, OPENAI_KEY_PARAMETER: "openai-key" }), /starts with \//);
});

test("openai: the request carries the render's text and the release's cap, the key rides as the bearer, read by name once; the client went through wrap()", async () => {
  const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), auth: new Headers(init?.headers ?? {}).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "gpt-5.6-luna", choices: [{ index: 0, message: { role: "assistant", content: "Thanks — the team" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const reads: string[] = [];
  const wrapped: unknown[] = [];
  const callers = createDirectCallers(fakeAp(wrapped), config, "us-east-1", { fetch, readSecret: async (name) => { reads.push(name); return "sk-test-openai"; } });
  const first = await callers.openai!.complete(rendered);
  const second = await callers.openai!.complete(rendered);
  assert.equal(first.text, "Thanks — the team");
  assert.deepEqual({ provider: first.provider, model: first.model, applied: first.applied, ignored: first.ignored }, { provider: "openai", model: "gpt-5.6-luna", applied: { max_completion_tokens: 600 }, ignored: ["temperature"] });
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.url, /api\.openai\.com\/v1\/chat\/completions$/);
  assert.equal(requests[0]!.auth, "Bearer sk-test-openai");
  assert.deepEqual(requests[0]!.body, { model: "gpt-5.6-luna", messages: [{ role: "user", content: rendered.text }], max_completion_tokens: 600 });
  assert.deepEqual(reads, ["/zudocs/dev/openai-key"], "the key parameter read by name, once for two calls");
  assert.equal(wrapped.length, 1, "one client, wrapped once");
  assert.ok(!JSON.stringify({ first, second }).includes("sk-test-openai"), "the key is in no record");
});

test("anthropic: messages.create with the render's text and max_tokens, the key as x-api-key; the text is the message's text blocks", async () => {
  const requests: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), key: new Headers(init?.headers ?? {}).get("x-api-key"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Hi Orbital — the team" }], stop_reason: "end_turn", usage: { input_tokens: 210, output_tokens: 38 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const callers = createDirectCallers(fakeAp([]), config, "us-east-1", { fetch, readSecret: async () => "sk-ant-test" });
  const out = await callers.anthropic!.complete(rendered);
  assert.equal(out.text, "Hi Orbital — the team");
  assert.deepEqual({ applied: out.applied, ignored: out.ignored }, { applied: { max_tokens: 600 }, ignored: ["temperature"] });
  assert.match(requests[0]!.url, /api\.anthropic\.com\/v1\/messages$/);
  assert.equal(requests[0]!.key, "sk-ant-test");
  assert.deepEqual(requests[0]!.body, { model: "claude-opus-5", max_tokens: 600, messages: [{ role: "user", content: rendered.text }] });
  // No cap on the release: a modest default, said on the record.
  const uncapped = createDirectCallers(fakeAp([]), config, "us-east-1", { fetch, readSecret: async () => "sk-ant-test" });
  const out2 = await uncapped.anthropic!.complete({ ...rendered, inference: undefined as never });
  assert.deepEqual(out2.applied, { max_tokens: 1024 });
});

test("an unreadable key parameter is a refusal that names the parameter and never the value; the next call retries", async () => {
  let attempts = 0;
  const callers = createDirectCallers(fakeAp([]), config, "us-east-1", { readSecret: async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); return "sk-later"; }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(callers.openai!.complete(rendered), (error: Error) => error.message.includes("/zudocs/dev/openai-key") && error.message.includes("AccessDeniedException") && !error.message.includes("sk-"));
  assert.equal((await callers.openai!.complete(rendered)).text, "ok");
  assert.equal(attempts, 2);
});
