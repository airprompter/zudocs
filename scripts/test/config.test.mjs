import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig, secretFromEnv } from "../lib/config.mjs";

test("the committed config names the dev deployment and the models the desk can call", () => {
  const config = readConfig({});
  assert.equal(config.baseUrl, "https://api-dev.airprompter.com", "phases 2–6 prove on dev; the prod cutover changes this line");
  assert.match(config.rootUrl, /\/roots\/dev\/root\.json$/);
  assert.equal(config.hostedEnvironment, "dev");
  assert.equal(config.environment, "dev");
  assert.match(config.agentId, /^agent_/);
  assert.deepEqual(config.models, ["amazon.nova-micro", "openai.gpt-5-6-luna", "anthropic.claude-haiku-4-5"], "the same three the desk host reports (services/desk-api/src/modelCatalogue.ts)");
  assert.ok(Object.isFrozen(config));
});

test("the environment overrides each identifier and the model list", () => {
  const config = readConfig({ AIRPROMPTER_BASE_URL: "http://127.0.0.1:4180", AIRPROMPTER_AGENT_ID: "agt_dev", AIRPROMPTER_ENVIRONMENT: "staging", AIRPROMPTER_MODELS: "a, b ,,c" });
  assert.equal(config.baseUrl, "http://127.0.0.1:4180");
  assert.equal(config.agentId, "agt_dev");
  assert.equal(config.environment, "staging");
  assert.deepEqual(config.models, ["a", "b", "c"]);
});

test("a bad environment or an empty model list is refused by name", () => {
  assert.throws(() => readConfig({ AIRPROMPTER_ENVIRONMENT: "production" }), /environment must be dev, staging or prod/);
  assert.throws(() => readConfig({ AIRPROMPTER_MODELS: " , " }), /models is empty/);
  assert.throws(() => readConfig({ AIRPROMPTER_AGENT_ID: "   " }), /agentId is missing/);
  assert.deepEqual(readConfig({ AIRPROMPTER_MODELS: "one-model" }).models, ["one-model"], "a single model needs no comma");
});

test("a secret comes from the environment only, and a missing one is named without echoing anything", () => {
  assert.equal(secretFromEnv("K", "a key", { K: " apa_x " }), "apa_x");
  assert.throws(() => secretFromEnv("AIRPROMPTER_AGENT_KEY", "an Agent key", {}), (error) => error.message.includes("AIRPROMPTER_AGENT_KEY") && error.message.includes("never on a command line"));
  assert.throws(() => secretFromEnv("K", "a key", { K: "" }), /K is not set/);
});
