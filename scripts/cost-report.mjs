#!/usr/bin/env node
/**
 * The cost report, from the owner's profile: the last seven and thirty full days from Cost Explorer by service and
 * by day, the Budgets document (spent, forecast), the fixed / variable split, and one line — *expected monthly at
 * current usage*. `--write` replaces the numbers section of the owner's cost document — `ZUDOCS_COST_DOC`, default
 * `~/.config/zudocs/COST.md`, kept outside the repository; created with the markers when missing, the text around them
 * untouched; `--json` prints the folded numbers instead of the tables. One Cost
 * Explorer query per run — thirty days by service, every page ($0.01 a page; one page in practice), the seven-day
 * fold from the same answer — the one line of this report that this report itself adds. No secrets.
 *
 * @example
 * ```sh
 * AWS_PROFILE=zudocs npm run cost:report                 # the tables
 * AWS_PROFILE=zudocs npm run cost:report -- --write      # and the owner's cost document's numbers section
 * AWS_PROFILE=zudocs npm run cost:report -- --json
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BudgetsClient, DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { NUMBERS_END, NUMBERS_START, budgetOf, costAndUsagePages, costQuery, costWindow, expectedMonthlyUsd, projectedSplit, renderNumbersSection, renderReport, spliceNumbers, summarise, within } from "./lib/cost.mjs";

const args = new Set(process.argv.slice(2));
const budgetName = process.env.ZUDOCS_BUDGET_NAME ?? "zudocs-monthly";
const now = new Date();

async function main() {
  // Cost Explorer and Budgets answer from us-east-1 whatever the profile's region says.
  const ce = new CostExplorerClient({ region: "us-east-1" });
  const budgets = new BudgetsClient({ region: "us-east-1" });
  const account = (await new STSClient({ region: "us-east-1" }).send(new GetCallerIdentityCommand({}))).Account;
  const window30 = costWindow(now, 30);
  const window7 = costWindow(now, 7);
  const { results: results30, calls } = await costAndUsagePages((q) => ce.send(new GetCostAndUsageCommand(q)), costQuery(window30));
  const last30 = summarise(results30, window30);
  const last7 = summarise(within(results30, window7), window7);
  if (calls > 1) console.error(`(Cost Explorer answered in ${calls} pages: $${(calls * 0.01).toFixed(2)})`);
  let budget = null;
  try {
    budget = budgetOf(await budgets.send(new DescribeBudgetCommand({ AccountId: account, BudgetName: budgetName })));
  } catch (error) {
    console.error(`(the budget ${budgetName} could not be read: ${error.name}; the report goes on without it)`);
  }
  if (args.has("--json")) {
    process.stdout.write(JSON.stringify({ generatedAt: now.toISOString(), last7, last30, budget, expectedMonthlyUsd: expectedMonthlyUsd(last7), projectedSplit: projectedSplit(last7) }, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport({ last7, last30, budget, now }));
  }
  if (args.has("--write")) {
    const path = process.env.ZUDOCS_COST_DOC ?? join(homedir(), ".config", "zudocs", "COST.md");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `# Zudocs — what it costs\n\n${NUMBERS_START}\n${NUMBERS_END}\n`, { mode: 0o600 });
    }
    const before = readFileSync(path, "utf8");
    const after = spliceNumbers(before, renderNumbersSection({ last7, last30, budget, now }));
    writeFileSync(path, after);
    console.error(`${path}: the numbers section ${after === before ? "is unchanged" : "was rewritten"}`);
  }
}

main().catch((error) => {
  console.error(`cost report failed: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
