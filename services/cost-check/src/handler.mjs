/**
 * The monthly cost check: on the third of the month (EventBridge Scheduler, `site-stack.ts`; Cost Explorer settles a
 * day about a day late) — or by hand with
 * `{ "month": "2026-09" }` — the previous month's Cost Explorer numbers by service and by day, the last seven full
 * days (the same query `npm run cost:report` makes, `scripts/lib/cost.mjs`), the Budgets document, and the
 * expected month at current usage: filed as `cost/YYYY-MM.json` in the trail bucket (which outlives every stack)
 * and put as `Zudocs/Cost` metrics (`expectedMonthlyUsd`, `monthUsd`, `budgetActualUsd`) so a graph and an alarm
 * can watch the line. Two Cost Explorer queries a month (the month, and the last seven days when they fall outside
 * it), every page ($0.01 a page; one each in practice). No secrets: nothing here is one.
 *
 * @example
 * ```sh
 * aws lambda invoke --function-name zudocs-cost-check --payload '{"month":"2026-09"}' /dev/stdout    # a partial month, filed as such
 * ```
 */
import { BudgetsClient, DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { METRIC_NAMESPACE, budgetOf, costAndUsagePages, costQuery, costWindow, expectedMonthlyUsd, monthWindow, monthlyDocument, previousMonth, summarise, within } from "../../../scripts/lib/cost.mjs";

const need = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`cost-check: ${name} is missing`);
  return value;
};

/** The check over ports: real clients in the handler, fakes in the test. */
export async function costCheck(event, ports) {
  const now = ports.now();
  const month = typeof event?.month === "string" && event.month.trim() ? event.month.trim() : previousMonth(now);
  const window = monthWindow(month);
  const today = now.toISOString().slice(0, 10);
  // Cost Explorer refuses an end beyond today's date; a month still running is filed up to today and marked partial.
  const partial = window.end > today;
  const effective = partial ? { ...window, end: today, days: Math.max(1, Math.round((Date.parse(today) - Date.parse(window.start)) / 86_400_000)) } : window;
  if (effective.end <= effective.start) throw new Error(`cost-check: ${month} has no full day yet`);
  const week = costWindow(now, 7);
  // The seven-day window is inside the month being filed when the check runs by hand mid-month: one query then serves both.
  const weekInside = week.start >= effective.start && week.end <= effective.end;
  const [{ results: monthResults, calls: monthCalls }, weekPage, budgetOut] = await Promise.all([costAndUsagePages(ports.costAndUsage, costQuery(effective)), weekInside ? Promise.resolve(null) : costAndUsagePages(ports.costAndUsage, costQuery(week)), ports.describeBudget(ports.budgetName)]);
  const monthSummary = summarise(monthResults, effective);
  const last7 = summarise(weekInside ? within(monthResults, week) : weekPage.results, week);
  const calls = monthCalls + (weekPage?.calls ?? 0);
  const budget = budgetOf(budgetOut);
  const document = monthlyDocument({ month, monthSummary, last7, budget, now, partial });
  const key = `${ports.prefix}${month}.json`;
  await ports.putObject(key, JSON.stringify(document, null, 2));
  const metrics = [
    { MetricName: "expectedMonthlyUsd", Value: document.expectedMonthlyUsd, Unit: "None" },
    { MetricName: "monthUsd", Value: monthSummary.total, Unit: "None", Dimensions: [{ Name: "month", Value: month }] },
    ...(budget?.actualUsd !== null && budget?.actualUsd !== undefined ? [{ MetricName: "budgetActualUsd", Value: budget.actualUsd, Unit: "None" }] : []),
  ].map((m) => ({ ...m, Timestamp: now }));
  await ports.putMetrics(metrics);
  return { month, partial, key, monthTotalUsd: monthSummary.total, expectedMonthlyUsd: expectedMonthlyUsd(last7), budgetActualUsd: budget?.actualUsd ?? null, metrics: metrics.map((m) => m.MetricName), costExplorerCalls: calls };
}

/** The Lambda entry: real clients; the bucket, the prefix and the budget's name from the environment. */
export const handler = async (event) => {
  const env = process.env;
  const region = need(env, "AWS_REGION");
  const ce = new CostExplorerClient({ region: "us-east-1" });
  const budgets = new BudgetsClient({ region: "us-east-1" });
  const cw = new CloudWatchClient({ region });
  const s3 = new S3Client({ region });
  const bucket = need(env, "COST_BUCKET");
  const answer = await costCheck(event ?? {}, {
    now: () => new Date(),
    budgetName: need(env, "BUDGET_NAME"),
    prefix: env.COST_PREFIX?.trim() || "cost/",
    costAndUsage: async (query) => ce.send(new GetCostAndUsageCommand(query)),
    describeBudget: async (name) => budgets.send(new DescribeBudgetCommand({ AccountId: need(env, "ACCOUNT_ID"), BudgetName: name })),
    putObject: async (key, body) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" })),
    putMetrics: async (data) => cw.send(new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: data })),
  });
  console.log(JSON.stringify({ source: "zudocs-cost-check", ...answer }));
  return answer;
};
