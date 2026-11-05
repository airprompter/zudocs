import assert from "node:assert/strict";
import { test } from "node:test";

import { AIMessage, HumanMessage, ToolMessage } from "langchain";

import { summarise } from "../src/agent.js";
import { matchArticles, planOf } from "../src/tools.js";

test("a search returns the articles that match", () => {
  assert.match(matchArticles("pdf export"), /Exporting to PDF/);
  assert.equal(matchArticles("zzzz"), "No article matches that search.");
});

test("a plan lookup names the customer's plan, and says when there is none", () => {
  assert.match(planOf("northwind"), /Team/);
  assert.equal(planOf("nobody"), "No customer is named nobody.");
});

test("an outcome counts model calls, tool calls and tokens across the whole request", () => {
  const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
  const outcome = summarise(
    [
      new HumanMessage("hi"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "search_docs", args: {} }], usage_metadata: usage }),
      new ToolMessage({ content: "found", tool_call_id: "1" }),
      new AIMessage({ content: "Done.\n\nZudocs Support", usage_metadata: usage }),
    ],
    5,
  );
  assert.deepEqual(outcome, { modelCalls: 2, toolCalls: 1, tokensIn: 20, tokensOut: 4, ms: 5, signed: true });
});
