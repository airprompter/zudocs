/**
 * The cost arithmetic `npm run cost:report` and the monthly cost-check Lambda share: the Cost Explorer query (daily,
 * by service, unblended), its answer folded by day and by service, the fixed / variable / tax split, the Budgets
 * document, the expected month at current usage — and the numbers section `docs/COST.md` carries between its
 * markers. Pure over the responses it is given: the tests pin the arithmetic, the callers do the calls.
 *
 * "Fixed" is what bills while nothing happens: the instance-hours and their volume and address, the zone, the
 * key. Everything else scales with use (models, invocations, reads and writes, log bytes, the report's own Cost
 * Explorer calls at $0.01 each). Tax is neither and is shown apart. Expected monthly = the last seven full days'
 * daily mean × the average month (30.44 days) — a measure, not a promise: the nightly sleep and demo mode move it.
 *
 * @example
 * ```js
 * const window = costWindow(new Date("2026-09-21T12:00:00Z"), 30);           // { start: "2026-08-22", end: "2026-09-21" } — full days, today excluded
 * const summary = summarise(response.ResultsByTime, window);                // { days, total, dailyMean, byService: [{ service, total, share, kind }], byDay: [...] }
 * expectedMonthlyUsd(summarise(last7, costWindow(now, 7)));                  // 15.42
 * spliceNumbers(docText, renderNumbersSection({ last7, last30, budget, now }));   // docs/COST.md with its numbers replaced
 * ```
 */

/** Services whose charge stands whether or not anything runs (by Cost Explorer's SERVICE dimension names). */
export const FIXED_SERVICES = Object.freeze([
  "Amazon Elastic Compute Cloud - Compute",
  "EC2 - Other",
  "Amazon Virtual Private Cloud",
  "Amazon Route 53",
  "AWS Key Management Service",
  "Amazon Registrar",
]);
export const TAX_SERVICES = Object.freeze(["Tax"]);
/** The average month, in days. */
export const MONTH_DAYS = 30.44;
/** The markers `docs/COST.md` keeps its generated numbers between. */
export const NUMBERS_START = "<!-- cost:numbers:start -->";
export const NUMBERS_END = "<!-- cost:numbers:end -->";
export const METRIC_NAMESPACE = "Zudocs/Cost";

const day = (date) => date.toISOString().slice(0, 10);
const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** The last `days` full UTC days before today: Cost Explorer's end is exclusive and today is partial. */
export function costWindow(now, days) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - days * 86_400_000);
  return { start: day(start), end: day(today), days };
}

/** One calendar month, UTC: `YYYY-MM` → its first day to the next month's first day (exclusive). */
export function monthWindow(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`cost: ${month} is not a YYYY-MM month`);
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return { start: day(start), end: day(end), days: Math.round((end - start) / 86_400_000), month };
}

/** The month before the one `now` is in, as `YYYY-MM` (what the monthly Lambda files on the first). */
export function previousMonth(now) {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previous = new Date(first.getTime() - 86_400_000);
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The GetCostAndUsage input for a window: daily, unblended, grouped by service. */
export function costQuery(window) {
  return { TimePeriod: { Start: window.start, End: window.end }, Granularity: "DAILY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }] };
}

export function kindOf(service) {
  if (TAX_SERVICES.includes(service)) return "tax";
  return FIXED_SERVICES.includes(service) ? "fixed" : "variable";
}

/** Cost Explorer's ResultsByTime folded: by day and by service, with the split and the daily mean over the window's days. */
export function summarise(resultsByTime, window) {
  const byServiceMap = new Map();
  const byDay = [];
  for (const result of resultsByTime ?? []) {
    const services = {};
    let total = 0;
    for (const group of result.Groups ?? []) {
      const service = group.Keys?.[0] ?? "unknown";
      const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? 0);
      if (!Number.isFinite(amount)) continue;
      services[service] = round((services[service] ?? 0) + amount, 6);
      total += amount;
      byServiceMap.set(service, (byServiceMap.get(service) ?? 0) + amount);
    }
    byDay.push({ day: result.TimePeriod?.Start ?? "?", total: round(total, 4), services });
  }
  byDay.sort((a, b) => (a.day < b.day ? -1 : 1));
  const total = [...byServiceMap.values()].reduce((a, b) => a + b, 0);
  const byService = [...byServiceMap.entries()].map(([service, amount]) => ({ service, total: round(amount, 4), share: total > 0 ? round(amount / total, 4) : 0, kind: kindOf(service) })).sort((a, b) => b.total - a.total);
  const split = { fixed: 0, variable: 0, tax: 0 };
  for (const row of byService) split[row.kind] += row.total;
  for (const k of Object.keys(split)) split[k] = round(split[k], 4);
  const days = window.days > 0 ? window.days : Math.max(byDay.length, 1);
  return { window: { start: window.start, end: window.end }, days, daysWithData: byDay.filter((d) => d.total > 0).length, total: round(total, 4), dailyMean: round(total / days, 4), byService, byDay, split };
}

/** The last seven full days' daily mean × the average month. */
export function expectedMonthlyUsd(summary7) {
  return round(summary7.dailyMean * MONTH_DAYS, 2);
}

/** The split projected the same way: what a month costs standing still, and what use adds. */
export function projectedSplit(summary7) {
  const days = summary7.days > 0 ? summary7.days : 1;
  return { fixed: round((summary7.split.fixed / days) * MONTH_DAYS, 2), variable: round((summary7.split.variable / days) * MONTH_DAYS, 2), tax: round((summary7.split.tax / days) * MONTH_DAYS, 2) };
}

/** The Budgets document's numbers: the limit, what was spent this month, what AWS forecasts (null until it has a forecast). */
export function budgetOf(describeBudgetOutput) {
  const b = describeBudgetOutput?.Budget;
  if (!b) return null;
  const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
  return { name: b.BudgetName ?? null, limitUsd: num(b.BudgetLimit?.Amount), actualUsd: num(b.CalculatedSpend?.ActualSpend?.Amount), forecastUsd: num(b.CalculatedSpend?.ForecastedSpend?.Amount), unit: b.BudgetLimit?.Unit ?? "USD" };
}

const usd = (n) => (n === null || n === undefined ? "—" : `$${(Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2)}`);
const pad = (s, n) => String(s).padEnd(n);

/** The terminal report: seven days by service, thirty days by day, the budget, the split, the one-line expectation. */
export function renderReport({ last7, last30, budget, now }) {
  const lines = [];
  lines.push(`Zudocs cost report — ${now.toISOString().slice(0, 16)}Z (Cost Explorer, unblended, USD; full UTC days, today excluded)`);
  lines.push("");
  lines.push(`Last 7 days (${last7.window.start} → ${last7.window.end}): ${usd(last7.total)} total · ${usd(last7.dailyMean)}/day`);
  for (const row of last7.byService) lines.push(`  ${pad(row.service, 44)} ${pad(usd(row.total), 9)} ${pad(`${(row.share * 100).toFixed(0)}%`, 5)} ${row.kind}`);
  lines.push("");
  lines.push(`Last 30 days (${last30.window.start} → ${last30.window.end}): ${usd(last30.total)} total · ${usd(last30.dailyMean)}/day over ${last30.days} days (${last30.daysWithData} with charges)`);
  for (const d of last30.byDay) {
    const top = Object.entries(d.services).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, v]) => `${s.replace(/^Amazon |^AWS /, "")} ${usd(v)}`).join(" · ");
    lines.push(`  ${d.day}  ${pad(usd(d.total), 8)} ${top}`);
  }
  lines.push("");
  const split = projectedSplit(last7);
  lines.push(`Fixed vs variable (7-day basis, projected to a month): fixed ${usd(split.fixed)} · variable ${usd(split.variable)}${split.tax ? ` · tax ${usd(split.tax)}` : ""}`);
  if (budget) lines.push(`Budget ${budget.name}: ${usd(budget.actualUsd)} spent this month of ${usd(budget.limitUsd)} · forecast ${budget.forecastUsd === null ? "not yet (AWS forecasts after a few weeks of data)" : usd(budget.forecastUsd)}`);
  lines.push("");
  lines.push(`Expected monthly at current usage: ${usd(expectedMonthlyUsd(last7))} (last 7 days × ${MONTH_DAYS} days)`);
  return lines.join("\n") + "\n";
}

/** The numbers section for docs/COST.md, markers included. */
export function renderNumbersSection({ last7, last30, budget, now }) {
  const split = projectedSplit(last7);
  const lines = [NUMBERS_START, `_Generated by \`npm run cost:report -- --write\` on ${now.toISOString().slice(0, 10)} from Cost Explorer (unblended, USD, full UTC days). Do not edit by hand; the explanations below the markers are hand-written._`, ""];
  lines.push(`| Measure | Value |`, `|---|---|`);
  lines.push(`| Last 7 days (${last7.window.start} → ${last7.window.end}) | ${usd(last7.total)} · ${usd(last7.dailyMean)}/day |`);
  lines.push(`| Last 30 days (${last30.window.start} → ${last30.window.end}) | ${usd(last30.total)} · ${usd(last30.dailyMean)}/day · ${last30.daysWithData} days with charges |`);
  lines.push(`| **Expected monthly at current usage** | **${usd(expectedMonthlyUsd(last7))}** (7-day mean × ${MONTH_DAYS} days) |`);
  lines.push(`| Fixed (standing) / variable (with use) / tax, projected | ${usd(split.fixed)} / ${usd(split.variable)} / ${usd(split.tax)} |`);
  if (budget) lines.push(`| Budget \`${budget.name}\` | ${usd(budget.actualUsd)} spent this month of ${usd(budget.limitUsd)} · forecast ${budget.forecastUsd === null ? "n/a" : usd(budget.forecastUsd)} |`);
  lines.push("", `| Service (last 7 days) | USD | Share | Kind |`, `|---|---|---|---|`);
  for (const row of last7.byService) lines.push(`| ${row.service} | ${usd(row.total)} | ${(row.share * 100).toFixed(0)}% | ${row.kind} |`);
  lines.push("", NUMBERS_END);
  return lines.join("\n");
}

/** The document with its numbers section replaced (the markers must both be present, in order). */
export function spliceNumbers(docText, section) {
  const start = docText.indexOf(NUMBERS_START);
  const end = docText.indexOf(NUMBERS_END);
  if (start < 0 || end < 0 || end < start) throw new Error(`docs/COST.md: the markers ${NUMBERS_START} … ${NUMBERS_END} are missing or out of order`);
  return docText.slice(0, start) + section + docText.slice(end + NUMBERS_END.length);
}

/** What the monthly Lambda files: one document per month, the same numbers the report prints. */
export function monthlyDocument({ month, monthSummary, last7, budget, now, partial }) {
  return {
    generatedAt: now.toISOString(),
    month,
    partial,
    monthTotalUsd: monthSummary.total,
    monthByService: monthSummary.byService,
    monthByDay: monthSummary.byDay.map((d) => ({ day: d.day, total: d.total })),
    monthSplit: monthSummary.split,
    last7: { window: last7.window, totalUsd: last7.total, dailyMeanUsd: last7.dailyMean, split: last7.split },
    expectedMonthlyUsd: expectedMonthlyUsd(last7),
    projectedSplit: projectedSplit(last7),
    budget,
  };
}
