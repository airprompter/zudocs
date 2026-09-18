/**
 * The desk API's pure parts: routing on the raw path (a bare event, no pathParameters), the tee (a real segment
 * body from the SDK's own multipart builder becomes EMF lines only on a 2xx, with the four dimensions and nothing
 * unbounded), the model catalogue and the Mantle body rewrite, the alias that keeps the release's model name on
 * the middleware while the wire sees Bedrock's, the triage parser, the variable origins, and the environment reader's
 * refusals.
 *
 * @example
 * ```sh
 * npx tsx --test test/units.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { multipartBody, type SpoolRow } from "@airprompter/agent-sdk";
import { aliasModel, rewriteMantleBody, textOfChat, mantleFetch } from "../src/bedrock.js";
import { readEnv } from "../src/env.js";
import { CATALOGUE, MODELS, bedrockIdOf, catalogueNameOf, costUsd } from "../src/modelCatalogue.js";
import { ROUTES, match } from "../src/router.js";
import { parseTriage, variableOrigins } from "../src/run.js";
import { SEED_CUSTOMERS, SEED_TICKETS } from "../src/seedData.js";
import { emfLinesOf, rowsOfUpload, teeFetch } from "../src/tee.js";

test("routes: matched on the raw path alone; parameters bounded; unknown paths and methods refused", () => {
  assert.deepEqual(match("POST", "/tickets/T-1041/run"), { name: "run_ticket", params: { ticketId: "T-1041" } });
  assert.deepEqual(match("GET", "/tickets/T-1041/"), { name: "get_ticket", params: { ticketId: "T-1041" } });
  assert.deepEqual(match("post", "/presenter/replay"), { name: "presenter", params: { action: "replay" } });
  assert.equal(match("GET", "/tickets/T-1041/run"), null, "the method is part of the route");
  assert.equal(match("GET", "/nope"), null);
  assert.equal(match("POST", "/tickets/" + "x".repeat(65) + "/run"), null, "a parameter past 64 characters is refused");
  assert.equal(match("POST", "/tickets/a%2Fb/run"), null, "an encoded slash is not a segment");
  assert.equal(new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`)).size, ROUTES.length, "every route key is distinct");
});

const window = (over: Partial<SpoolRow> = {}): SpoolRow =>
  ({ type: "window", v: 1, minute: "2026-09-18T14:03:00Z", instanceId: "i-abcdefghijkl", instanceClass: "ephemeral", tag: "support.reply", versionId: "rev-2", arm: "none", model: "openai.gpt-5-6-luna", status: "ok", errorClass: null, usageSource: "reported", count: 2, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0], sum: 2400 }, tokens: { input: 300, cachedInput: 20, output: 90 }, checks: { passed: 5, failed: 1 }, outcomes: { judgeScore: { n: 2, sum: 1.5 } }, sdk: "agent-sdk-ts/0.2.14", ...over }) as SpoolRow;

test("tee: a real segment upload body (the SDK's multipart builder) yields its rows; anything else yields null", () => {
  const rows = [window(), { type: "refusal", v: 1, at: "2026-09-18T14:03:10Z", instanceId: "i-abcdefghijkl", reason: "disabled", generation: 3, tag: "support.reply" } as SpoolRow];
  const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const boundary = "----airprompterTEST";
  const body = multipartBody(boundary, [["key", "prefix/seg-i-abcdefghijkl-1-0.ndjson"], ["Content-Type", "application/x-ndjson"]], { name: "seg-i-abcdefghijkl-1-0.ndjson", contentType: "application/x-ndjson", bytes });
  const parsed = rowsOfUpload({ "content-type": `multipart/form-data; boundary=${boundary}` }, body);
  assert.ok(parsed && parsed.length === 2, "two validated rows");
  assert.equal(parsed![0]!.type, "window");
  assert.equal(rowsOfUpload({ "content-type": "application/json" }, "{}"), null, "a heartbeat is not a segment");
  assert.equal(rowsOfUpload(undefined, body), null);
});

test("tee: EMF lines carry exactly the four bounded dimensions, the window's counts, no text; refusals and drops count under their own", () => {
  const [line, refusal, dropped] = emfLinesOf([window(), { type: "refusal", v: 1, at: "2026-09-18T14:03:10Z", instanceId: "i-x", reason: "disabled", generation: 3, tag: null } as SpoolRow, { type: "dropped", v: 1, at: "2026-09-18T14:03:10Z", instanceId: "i-x", segments: 2, bytes: 4096 } as SpoolRow], "Zudocs/Desk", { host: "us-east-1/lambda" });
  const parsed = JSON.parse(line!);
  assert.deepEqual(parsed._aws.CloudWatchMetrics[0].Dimensions, [["tag", "versionId", "arm", "status"]]);
  assert.equal(parsed._aws.CloudWatchMetrics[0].Namespace, "Zudocs/Desk");
  assert.equal(parsed._aws.Timestamp, Date.parse("2026-09-18T14:03:00Z"));
  assert.equal(parsed.runs, 2);
  assert.equal(parsed.latencyMs, 1200, "the window's mean latency");
  assert.equal(parsed.inputTokens, 320, "cached input counts as input");
  assert.equal(parsed.outputTokens, 90);
  assert.equal(parsed.checksPassed, 5);
  assert.equal(parsed.outcome_judgeScore, 0.75);
  assert.equal(parsed.host, "us-east-1/lambda");
  const names = parsed._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name);
  assert.deepEqual(names, ["runs", "latencyMs", "inputTokens", "outputTokens", "checksPassed", "checksFailed", "outcome_judgeScore"]);
  assert.deepEqual(JSON.parse(refusal!)._aws.CloudWatchMetrics[0].Dimensions, [["reason"]]);
  assert.equal(JSON.parse(refusal!).refusals, 1);
  assert.equal(JSON.parse(dropped!).droppedSegments, 2);
  assert.ok(!line!.includes("instanceClass"), "nothing beyond the row's numbers and names");
});

test("tee: the fetch forwards everything untouched and emits only after a 2xx on a segment upload", async () => {
  const seen: Array<{ url: string; status: number }> = [];
  const emitted: string[] = [];
  let status = 200;
  const inner = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    seen.push({ url, status });
    return { status, text: async () => "" };
  };
  const fetch = teeFetch(inner, { namespace: "Zudocs/Desk", emit: (line) => emitted.push(line) });
  const bytes = Buffer.from(JSON.stringify(window()) + "\n", "utf8");
  const boundary = "----b";
  const body = multipartBody(boundary, [["key", "k"], ["Content-Type", "application/x-ndjson"]], { name: "seg.ndjson", contentType: "application/x-ndjson", bytes });
  const init = { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body };
  status = 403;
  await fetch("https://uploads.example/", init);
  assert.equal(emitted.length, 0, "a refused upload emits nothing: the SDK requeues the rows");
  status = 204;
  await fetch("https://uploads.example/", init);
  assert.equal(emitted.length, 1, "the accepted upload's window became one metric line");
  await fetch("https://api.example/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(emitted.length, 1, "a heartbeat is not a metric");
  assert.equal(seen.length, 3, "every request was forwarded");
});

test("catalogue: three models under AirPrompter's names, each mapped to Bedrock's; the Mantle body carries Bedrock's id; cost from reported usage only", () => {
  assert.deepEqual(MODELS, ["openai.gpt-5-6-luna", "amazon.nova-micro", "anthropic.claude-haiku-4-5"]);
  assert.equal(bedrockIdOf("openai.gpt-5-6-luna"), "openai.gpt-5.6-luna");
  assert.equal(bedrockIdOf("amazon.nova-micro"), "us.amazon.nova-micro-v1:0");
  assert.equal(catalogueNameOf("us.anthropic.claude-haiku-4-5-20251001-v1:0"), "anthropic.claude-haiku-4-5");
  assert.throws(() => bedrockIdOf("openai.gpt-6-astra"), /cannot call/);
  for (const [name, entry] of Object.entries(CATALOGUE)) assert.ok(entry.bedrockId.endsWith(entry.foundationModelId) || entry.bedrockId === entry.foundationModelId, `${name}: the profile wraps its foundation model`);
  const body = rewriteMantleBody(JSON.stringify({ model: "openai.gpt-5-6-luna", messages: [{ role: "user", content: "x" }], max_completion_tokens: 600, reasoning_effort: "low" }));
  assert.deepEqual(JSON.parse(body), { model: "openai.gpt-5.6-luna", messages: [{ role: "user", content: "x" }], max_completion_tokens: 600, reasoning_effort: "low" });
  assert.equal(JSON.parse(rewriteMantleBody(JSON.stringify({ model: "something-else" }))).model, "something-else", "an unknown name is passed through for Bedrock to refuse");
  assert.equal(costUsd("openai.gpt-5-6-luna", { input: 1_000_000, output: 1_000_000 }, "reported"), 1.4);
  assert.equal(costUsd("openai.gpt-5-6-luna", { input: 10, output: 10 }, "unavailable"), null, "no usage, no cost line");
});

test("mantle fetch: the client's bearer is dropped, the body's model is Bedrock's, the request is SigV4-signed for bedrock-mantle with a session token", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const inner = async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init! };
    return new Response("{}", { status: 200 });
  };
  const fetch = mantleFetch("us-east-1", async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token" }), inner);
  const controller = new AbortController();
  await fetch("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sigv4", "content-type": "application/json", "x-stainless-lang": "js" }, body: JSON.stringify({ model: "openai.gpt-5-6-luna", messages: [] }), signal: controller.signal });
  const headers = captured!.init.headers as Record<string, string>;
  assert.equal(captured!.init.signal, controller.signal, "the client's abort signal (its timeout) reaches the wire");
  assert.match(headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=/);
  assert.equal(headers["x-amz-security-token"], "token");
  assert.equal(headers["x-stainless-lang"], "js", "diagnostic headers ride along");
  assert.equal(JSON.parse(captured!.init.body as string).model, "openai.gpt-5.6-luna");
});

test("alias: the middleware sees the release's model name while the provider keeps calling with its own", async () => {
  const calls: string[] = [];
  const inner = { specificationVersion: "v4", provider: "bedrock", modelId: "us.amazon.nova-micro-v1:0", supportedUrls: {}, doGenerate(this: { modelId: string }) { calls.push(this.modelId); return Promise.resolve({ ok: true }); }, doStream() { return Promise.resolve({}); } };
  const aliased = aliasModel(inner, "amazon.nova-micro");
  assert.equal(aliased.modelId, "amazon.nova-micro");
  assert.equal(aliased.provider, "bedrock");
  await aliased.doGenerate();
  assert.deepEqual(calls, ["us.amazon.nova-micro-v1:0"], "the call ran on the provider's own id");
});

test("chat text: a string, text parts, or nothing", () => {
  assert.equal(textOfChat({ choices: [{ message: { content: "hello" } }] }), "hello");
  assert.equal(textOfChat({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }), "ab");
  assert.equal(textOfChat({}), "");
});

test("triage parsing tolerates a fenced block and yields nulls for anything else", () => {
  assert.deepEqual(parseTriage('```json\n{"category":"search","priority":"normal","summary":"s"}\n```'), { category: "search", priority: "normal", summary: "s" });
  assert.deepEqual(parseTriage("not json"), { category: null, priority: null, summary: null });
});

test("variable origins follow the SDK's precedence: call site, then the desk's source, then the default; end-user values are fenced", () => {
  const declared = [
    { name: "tone", required: false, trust: "operator" as const, default: "friendly" },
    { name: "customer_tier", required: true, trust: "operator" as const, source: "runtime" as const },
    { name: "ticket", required: true, trust: "end_user" as const },
    { name: "orphan", required: true, trust: "operator" as const },
  ];
  const origins = variableOrigins(declared, { ticket: "help", tone: "formal" }, ["customer_tier"], { customer_tier: "enterprise" });
  assert.deepEqual(origins.map((o) => [o.name, o.origin, o.value, o.fenced]), [
    ["tone", "call_site", "formal", false],
    ["customer_tier", "your_source", "enterprise", false],
    ["ticket", "call_site", "help", true],
    ["orphan", "unfilled", null, false],
  ]);
  assert.equal(variableOrigins(declared, { ticket: "help" }, ["customer_tier"], {})[0]!.origin, "default");
});

test("seed: every ticket names a seeded customer; ids are stable and unique; every tier appears", () => {
  const ids = new Set(SEED_CUSTOMERS.map((c) => c.customerId));
  for (const ticket of SEED_TICKETS) assert.ok(ids.has(ticket.customerId), ticket.ticketId);
  assert.equal(new Set(SEED_TICKETS.map((t) => t.ticketId)).size, SEED_TICKETS.length);
  assert.deepEqual([...new Set(SEED_CUSTOMERS.map((c) => c.tier))].sort(), ["enterprise", "team", "trial"]);
});

test("env: names are required, the key parameter is a name, the cap is a positive integer; nothing key-shaped is read", () => {
  const base = { TICKETS_TABLE: "t", CUSTOMERS_TABLE: "c", RUNS_TABLE: "r", FEEDBACK_TABLE: "f", STATUS_TABLE: "s", EVENTS_TABLE: "e", COUNTERS_TABLE: "n", KMS_KEY_ID: "k", AGENT_KEY_PARAMETER: "/zudocs/dev/agent-key", AIRPROMPTER_BASE_URL: "https://api-dev.airprompter.com", AIRPROMPTER_ORGANIZATION_ID: "o", AIRPROMPTER_AGENT_ID: "a", AIRPROMPTER_ENVIRONMENT: "dev", AIRPROMPTER_HOSTED_ENVIRONMENT: "dev", AIRPROMPTER_ROOT_URL: "https://x/root.json", AIRPROMPTER_ROOT_JWK: "{}", DAILY_RUN_CAP: "2000", STATE_EPOCH: "1" };
  const env = readEnv(base);
  assert.equal(env.stateDir, "/tmp/airprompter/1");
  assert.equal(env.dailyRunCap, 2000);
  assert.throws(() => readEnv({ ...base, TICKETS_TABLE: "" }), /TICKETS_TABLE is missing/);
  assert.throws(() => readEnv({ ...base, AGENT_KEY_PARAMETER: "apa_test_xxx" }), /parameter name/);
  assert.throws(() => readEnv({ ...base, DAILY_RUN_CAP: "0" }), /positive integer/);
  assert.ok(!JSON.stringify(env).includes("AGENT_KEY") || JSON.stringify(env).includes("/zudocs/dev/agent-key"), "the env carries the parameter's name only");
});
