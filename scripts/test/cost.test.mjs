import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_SERVICES, MONTH_DAYS, NUMBERS_END, NUMBERS_START, budgetOf, costAndUsagePages, costQuery, costWindow, expectedMonthlyUsd, kindOf, monthWindow, monthlyDocument, previousMonth, projectedSplit, renderNumbersSection, renderReport, spliceNumbers, summarise, within } from "../lib/cost.mjs";

const NOW = new Date("2026-09-21T14:30:00.000Z");
const group = (service, amount) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: String(amount), Unit: "USD" } } });
const day = (start, groups) => ({ TimePeriod: { Start: start, End: start }, Groups: groups });
// Two full days of the shape Cost Explorer answers with (the account's real 2026-09-19/20 numbers, rounded).
const RESULTS = [
  day("2026-09-19", [group("Amazon Bedrock", 0.266), group("Amazon Elastic Compute Cloud - Compute", 0.269), group("Amazon Virtual Private Cloud", 0.12), group("EC2 - Other", 0.028), group("AWS Key Management Service", 0.048), group("Amazon DynamoDB", 0.045), group("Amazon Route 53", 0.101), group("AWS Cost Explorer", 0.03), group("Tax", 0.05)]),
  day("2026-09-20", [group("Amazon Bedrock", 0.104), group("Amazon Elastic Compute Cloud - Compute", 0.223), group("Amazon Virtual Private Cloud", 0.12), group("EC2 - Other", 0.023), group("AWS Key Management Service", 0.043), group("Amazon DynamoDB", 0.033)]),
  day("2026-09-18", []),
];

test("windows: full UTC days ending yesterday (Cost Explorer's end is exclusive and today is partial); a month; the previous month", () => {
  assert.deepEqual(costWindow(NOW, 7), { start: "2026-09-14", end: "2026-09-21", days: 7 });
  assert.deepEqual(costWindow(NOW, 30), { start: "2026-08-22", end: "2026-09-21", days: 30 });
  assert.deepEqual(costWindow(new Date("2026-10-01T00:30:00.000Z"), 1), { start: "2026-09-30", end: "2026-10-01", days: 1 }, "just after midnight UTC: yesterday is the one full day");
  assert.deepEqual(monthWindow("2026-09"), { start: "2026-09-01", end: "2026-10-01", days: 30, month: "2026-09" });
  assert.deepEqual(monthWindow("2026-12"), { start: "2026-12-01", end: "2027-01-01", days: 31, month: "2026-12" });
  assert.throws(() => monthWindow("2026-9"), /YYYY-MM/);
  assert.equal(previousMonth(NOW), "2026-08");
  assert.equal(previousMonth(new Date("2027-01-01T06:00:00.000Z")), "2026-12", "the January run files December");
  assert.deepEqual(costQuery(costWindow(NOW, 7)), { TimePeriod: { Start: "2026-09-14", End: "2026-09-21" }, Granularity: "DAILY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }] });
});

test("the fold: by day (sorted) and by service (largest first, with share and kind), the split, the daily mean over the window's days — not over the days with data", () => {
  const s = summarise(RESULTS, costWindow(NOW, 7));
  assert.equal(s.days, 7);
  assert.equal(s.daysWithData, 2, "the empty day is counted as a day, not as data");
  assert.equal(s.total, 1.503);
  assert.equal(s.dailyMean, 0.2147, "the total over seven days, so a quiet week reads as quiet");
  assert.deepEqual(s.byDay.map((d) => [d.day, d.total]), [["2026-09-18", 0], ["2026-09-19", 0.957], ["2026-09-20", 0.546]]);
  assert.equal(s.byService[0].service, "Amazon Elastic Compute Cloud - Compute");
  assert.equal(s.byService[0].total, 0.492);
  assert.equal(s.byService[0].kind, "fixed");
  assert.equal(s.byService.find((r) => r.service === "Amazon Bedrock").kind, "variable");
  assert.equal(s.byService.find((r) => r.service === "Amazon Bedrock").total, 0.37);
  assert.equal(s.byService.find((r) => r.service === "Tax").kind, "tax");
  const shares = s.byService.reduce((a, r) => a + r.share, 0);
  assert.ok(Math.abs(shares - 1) < 0.01, `shares sum to one (${shares})`);
  assert.deepEqual(s.split, { fixed: 0.975, variable: 0.478, tax: 0.05 });
  assert.equal(Math.round((s.split.fixed + s.split.variable + s.split.tax) * 1000) / 1000, s.total, "the split is a partition of the total");
  for (const name of FIXED_SERVICES) assert.equal(kindOf(name), "fixed");
  assert.equal(kindOf("AWS Lambda"), "variable");
  assert.equal(kindOf("Tax"), "tax");
  const empty = summarise([], costWindow(NOW, 7));
  assert.deepEqual([empty.total, empty.dailyMean, empty.byService, empty.split], [0, 0, [], { fixed: 0, variable: 0, tax: 0 }]);
  assert.equal(summarise([day("2026-09-19", [{ Keys: ["X"], Metrics: { UnblendedCost: { Amount: "nope" } } }])], costWindow(NOW, 1)).total, 0, "an unparseable amount is skipped, never NaN");
});

test("the projection: seven-day mean × the average month, and the split projected the same way", () => {
  const s = summarise(RESULTS, costWindow(NOW, 7));
  assert.equal(MONTH_DAYS, 30.44);
  assert.equal(expectedMonthlyUsd(s), 6.54, "0.2147 × 30.44");
  assert.deepEqual(projectedSplit(s), { fixed: 4.24, variable: 2.08, tax: 0.22 });
  const week = summarise([day("2026-09-19", [group("Amazon Bedrock", 1)])], { start: "a", end: "b", days: 7 });
  assert.equal(expectedMonthlyUsd(week), 4.35, "one dollar in a week is $4.35 a month");
});

test("the budget document: limit, actual, forecast (null until AWS has one); nothing without a Budget", () => {
  assert.deepEqual(budgetOf({ Budget: { BudgetName: "zudocs-monthly", BudgetLimit: { Amount: "30.0", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "1.835", Unit: "USD" } } } }), { name: "zudocs-monthly", limitUsd: 30, actualUsd: 1.835, forecastUsd: null, unit: "USD" });
  assert.equal(budgetOf({ Budget: { BudgetName: "b", BudgetLimit: { Amount: "30" }, CalculatedSpend: { ActualSpend: { Amount: "2" }, ForecastedSpend: { Amount: "7.5" } } } }).forecastUsd, 7.5);
  assert.equal(budgetOf({}), null);
  assert.equal(budgetOf(undefined), null);
});

test("the report and the numbers section: every line the owner reads, the markers kept, the splice replaces exactly the section", () => {
  const last7 = summarise(RESULTS, costWindow(NOW, 7));
  const last30 = summarise(RESULTS, costWindow(NOW, 30));
  const budget = budgetOf({ Budget: { BudgetName: "zudocs-monthly", BudgetLimit: { Amount: "30", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "1.835" } } } });
  const report = renderReport({ last7, last30, budget, now: NOW });
  assert.match(report, /Last 7 days \(2026-09-14 → 2026-09-21\): \$1\.50 total · \$0\.21\/day/);
  assert.match(report, /Amazon Elastic Compute Cloud - Compute\s+\$0\.49\s+33%\s+fixed/);
  assert.match(report, /2026-09-19 {2}\$0\.96 {4}Elastic Compute Cloud - Compute \$0\.27 · Bedrock \$0\.27/);
  assert.match(report, /Fixed vs variable \(7-day basis, projected to a month\): fixed \$4\.24 · variable \$2\.08 · tax \$0\.22/);
  assert.match(report, /Budget zudocs-monthly: \$1\.84 spent this month of \$30\.00 · forecast not yet/);
  assert.match(report, /Expected monthly at current usage: \$6\.54 \(last 7 days × 30\.44 days\)/);
  assert.ok(!/apa_|apr_|AKIA/.test(report));
  const section = renderNumbersSection({ last7, last30, budget, now: NOW });
  assert.ok(section.startsWith(NUMBERS_START) && section.endsWith(NUMBERS_END));
  assert.match(section, /\| \*\*Expected monthly at current usage\*\* \| \*\*\$6\.54\*\* \(7-day mean × 30\.44 days\) \|/);
  assert.match(section, /\| Amazon Bedrock \| \$0\.37 \| 25% \| variable \|/);
  assert.match(section, /Generated by `npm run cost:report -- --write` on 2026-09-21/);
  const doc = `# Cost\n\nintro\n\n${NUMBERS_START}\nold numbers\n${NUMBERS_END}\n\n## Explanations\n\nhand-written\n`;
  const spliced = spliceNumbers(doc, section);
  assert.ok(spliced.startsWith("# Cost\n\nintro\n\n" + NUMBERS_START), "everything before the markers is kept");
  assert.ok(spliced.endsWith(NUMBERS_END + "\n\n## Explanations\n\nhand-written\n"), "everything after them is kept");
  assert.ok(!spliced.includes("old numbers"));
  assert.equal(spliceNumbers(spliced, section), spliced, "idempotent");
  assert.throws(() => spliceNumbers("no markers here", section), /markers/);
  assert.throws(() => spliceNumbers(`${NUMBERS_END}\n${NUMBERS_START}`, section), /out of order/);
});

test("the monthly document: the month's numbers, the seven-day projection, the budget, partial when the month is still running", () => {
  const monthSummary = summarise(RESULTS, monthWindow("2026-09"));
  const last7 = summarise(RESULTS, costWindow(NOW, 7));
  const doc = monthlyDocument({ month: "2026-09", monthSummary, last7, budget: null, now: NOW, partial: true });
  assert.equal(doc.month, "2026-09");
  assert.equal(doc.partial, true);
  assert.equal(doc.monthTotalUsd, 1.503);
  assert.equal(doc.expectedMonthlyUsd, 6.54);
  assert.deepEqual(doc.monthByDay.map((d) => d.day), ["2026-09-18", "2026-09-19", "2026-09-20"]);
  assert.equal(doc.budget, null);
  assert.equal(doc.generatedAt, "2026-09-21T14:30:00.000Z");
});

test("the pager follows NextPageToken to the end, counts its calls, and refuses to keep paying past ten pages; `within` keeps the rows of a narrower window", async () => {
  const pages = { undefined: { ResultsByTime: [day("2026-09-01", [])], NextPageToken: "b" }, b: { ResultsByTime: [day("2026-09-02", [])], NextPageToken: "c" }, c: { ResultsByTime: [day("2026-09-03", [])] } };
  const sent = [];
  const { results, calls } = await costAndUsagePages(async (q) => { sent.push(q.NextPageToken); return pages[q.NextPageToken]; }, costQuery(costWindow(NOW, 30)));
  assert.equal(calls, 3);
  assert.deepEqual(sent, [undefined, "b", "c"]);
  assert.deepEqual(results.map((r) => r.TimePeriod.Start), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  let n = 0;
  await assert.rejects(costAndUsagePages(async () => { n += 1; return { ResultsByTime: [], NextPageToken: "more" }; }, costQuery(costWindow(NOW, 30))), /more than 10 pages/);
  assert.equal(n, 10, "ten pages were paid for, not eleven");
  const thirty = [];
  for (let i = 30; i >= 1; i -= 1) thirty.push(day(new Date(Date.UTC(2026, 8, 21) - i * 86_400_000).toISOString().slice(0, 10), [group("Amazon Bedrock", 0.1)]));
  const week = within(thirty, costWindow(NOW, 7));
  assert.equal(week.length, 7);
  assert.deepEqual([week[0].TimePeriod.Start, week.at(-1).TimePeriod.Start], ["2026-09-14", "2026-09-20"], "the seven full days before today, today excluded");
  assert.equal(summarise(week, costWindow(NOW, 7)).total, 0.7);
});
