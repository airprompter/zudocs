import assert from "node:assert/strict";
import { test } from "node:test";
import { costCheck } from "../src/handler.mjs";

const NOW = new Date("2026-10-01T06:00:05.000Z");
const group = (service, amount) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: String(amount), Unit: "USD" } } });
const dayOf = (start, groups) => ({ TimePeriod: { Start: start, End: start }, Groups: groups });

function ports(now = NOW) {
  const calls = [];
  const objects = new Map();
  const metrics = [];
  return {
    calls, objects, metrics,
    now: () => now,
    budgetName: "zudocs-monthly",
    prefix: "cost/",
    costAndUsage: async (query) => {
      calls.push(`ce:${query.TimePeriod.Start}→${query.TimePeriod.End}`);
      return [dayOf(query.TimePeriod.Start, [group("Amazon Bedrock", 0.2), group("Amazon Elastic Compute Cloud - Compute", 0.25)])];
    },
    describeBudget: async (name) => { calls.push(`budget:${name}`); return { Budget: { BudgetName: name, BudgetLimit: { Amount: "30", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "0.45" } } } }; },
    putObject: async (key, body) => { calls.push(`put:${key}`); objects.set(key, JSON.parse(body)); },
    putMetrics: async (data) => { calls.push(`metrics:${data.map((m) => m.MetricName).join(",")}`); metrics.push(...data); },
  };
}

test("on the first of the month the previous month is filed in full: two Cost Explorer calls, the budget, one document, three metrics", async () => {
  const p = ports();
  const answer = await costCheck({}, p);
  assert.equal(answer.month, "2026-09");
  assert.equal(answer.partial, false);
  assert.equal(answer.key, "cost/2026-09.json");
  assert.deepEqual(p.calls, ["ce:2026-09-01→2026-10-01", "ce:2026-09-24→2026-10-01", "budget:zudocs-monthly", "put:cost/2026-09.json", "metrics:expectedMonthlyUsd,monthUsd,budgetActualUsd"]);
  const doc = p.objects.get("cost/2026-09.json");
  assert.equal(doc.month, "2026-09");
  assert.equal(doc.partial, false);
  assert.equal(doc.monthTotalUsd, 0.45);
  assert.equal(doc.budget.actualUsd, 0.45);
  assert.equal(doc.expectedMonthlyUsd, 1.96, "0.45 over 7 days × 30.44");
  assert.equal(answer.expectedMonthlyUsd, 1.96);
  assert.deepEqual(p.metrics.map((m) => [m.MetricName, m.Value]), [["expectedMonthlyUsd", 1.96], ["monthUsd", 0.45], ["budgetActualUsd", 0.45]]);
  assert.deepEqual(p.metrics[1].Dimensions, [{ Name: "month", Value: "2026-09" }]);
  assert.ok(p.metrics.every((m) => m.Timestamp === NOW));
});

test("a month named by hand that is still running is filed up to today and marked partial; a month with no full day is refused", async () => {
  const p = ports(new Date("2026-09-21T14:00:00.000Z"));
  const answer = await costCheck({ month: "2026-09" }, p);
  assert.equal(answer.partial, true);
  assert.equal(p.calls[0], "ce:2026-09-01→2026-09-21", "Cost Explorer refuses an end beyond today");
  assert.equal(p.objects.get("cost/2026-09.json").partial, true);
  await assert.rejects(costCheck({ month: "2026-09" }, ports(new Date("2026-09-01T03:00:00.000Z"))), /no full day yet/);
  await assert.rejects(costCheck({ month: "sept" }, ports()), /YYYY-MM/);
});
