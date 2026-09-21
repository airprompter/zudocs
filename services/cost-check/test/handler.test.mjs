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
      calls.push(`ce:${query.TimePeriod.Start}→${query.TimePeriod.End}${query.NextPageToken ? `#${query.NextPageToken}` : ""}`);
      // One row per day of the window, in two pages when the window is long: the reader must follow NextPageToken.
      const days = [];
      for (let d = new Date(`${query.TimePeriod.Start}T00:00:00Z`); d.toISOString().slice(0, 10) < query.TimePeriod.End; d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10));
      const page = query.NextPageToken === "p2" ? days.slice(15) : days.slice(0, 15);
      return { ResultsByTime: page.map((day) => dayOf(day, [group("Amazon Bedrock", 0.2), group("Amazon Elastic Compute Cloud - Compute", 0.25)])), ...(days.length > 15 && !query.NextPageToken ? { NextPageToken: "p2" } : {}) };
    },
    describeBudget: async (name) => { calls.push(`budget:${name}`); return { Budget: { BudgetName: name, BudgetLimit: { Amount: "30", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "0.45" } } } }; },
    putObject: async (key, body) => { calls.push(`put:${key}`); objects.set(key, JSON.parse(body)); },
    putMetrics: async (data) => { calls.push(`metrics:${data.map((m) => m.MetricName).join(",")}`); metrics.push(...data); },
  };
}

test("on the third of the month the previous month is filed in full: every page of the month, the seven-day window inside it, the budget, one document, three metrics", async () => {
  const p = ports(new Date("2026-10-03T06:00:05.000Z"));
  const answer = await costCheck({}, p);
  assert.equal(answer.month, "2026-09");
  assert.equal(answer.partial, false);
  assert.equal(answer.key, "cost/2026-09.json");
  assert.deepEqual([...p.calls].sort(), ["budget:zudocs-monthly", "ce:2026-09-01→2026-10-01", "ce:2026-09-01→2026-10-01#p2", "ce:2026-09-26→2026-10-03", "metrics:expectedMonthlyUsd,monthUsd,budgetActualUsd", "put:cost/2026-09.json"], "both pages of the month; the seven-day window straddles the month end so it is its own query (the reads run concurrently)");
  assert.equal(answer.costExplorerCalls, 3);
  const doc = p.objects.get("cost/2026-09.json");
  assert.equal(doc.month, "2026-09");
  assert.equal(doc.partial, false);
  assert.equal(doc.monthByDay.length, 30, "every day of the month, across the pages");
  assert.equal(doc.monthTotalUsd, 13.5, "30 days × $0.45");
  assert.equal(doc.budget.actualUsd, 0.45);
  assert.equal(doc.expectedMonthlyUsd, 13.7, "7 × 0.45 over 7 days × 30.44");
  assert.equal(answer.expectedMonthlyUsd, 13.7);
  assert.deepEqual(p.metrics.map((m) => [m.MetricName, m.Value]), [["expectedMonthlyUsd", 13.7], ["monthUsd", 13.5], ["budgetActualUsd", 0.45]]);
  assert.deepEqual(p.metrics[1].Dimensions, [{ Name: "month", Value: "2026-09" }]);
  assert.ok(p.metrics.every((m) => m.Timestamp.toISOString() === "2026-10-03T06:00:05.000Z"), "the metrics carry the run's instant");
});

test("a month named by hand that is still running is filed up to today and marked partial (the seven-day window inside it comes from the same answer); a month with no full day is refused", async () => {
  const p = ports(new Date("2026-09-21T14:00:00.000Z"));
  const answer = await costCheck({ month: "2026-09" }, p);
  assert.equal(answer.partial, true);
  assert.deepEqual(p.calls.filter((c) => c.startsWith("ce:")), ["ce:2026-09-01→2026-09-21", "ce:2026-09-01→2026-09-21#p2"], "Cost Explorer refuses an end beyond today; the seven-day window is inside the month, so no second query");
  assert.equal(answer.costExplorerCalls, 2);
  assert.equal(p.objects.get("cost/2026-09.json").partial, true);
  assert.equal(p.objects.get("cost/2026-09.json").last7.totalUsd, 3.15, "seven days × $0.45 from the month's own rows");
  await assert.rejects(costCheck({ month: "2026-09" }, ports(new Date("2026-09-01T03:00:00.000Z"))), /no full day yet/);
  await assert.rejects(costCheck({ month: "sept" }, ports()), /YYYY-MM/);
});
