#!/usr/bin/env node
/**
 * The cost report, from the owner's profile: the last seven and thirty full days from Cost Explorer by service and
 * by day, the Budgets document (spent, forecast), the fixed / variable split, and one line — *expected monthly at
 * current usage*. `--write` replaces the numbers section of `docs/COST.md` (between its markers; the explanations
 * below them are hand-written and untouched); `--json` prints the folded numbers instead of the tables. Two Cost
 * Explorer calls per run ($0.01 each — the one line of this report that this report itself adds). No secrets.
 *
 * @example
 * ```sh
 * AWS_PROFILE=zudocs npm run cost:report                 # the tables
 * AWS_PROFILE=zudocs npm run cost:report -- --write      # and docs/COST.md's numbers section
 * AWS_PROFILE=zudocs npm run cost:report -- --json
 * ```
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetsClient, DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { repoRoot } from "./lib/config.mjs";
import { budgetOf, costQuery, costWindow, expectedMonthlyUsd, projectedSplit, renderNumbersSection, renderReport, spliceNumbers, summarise } from "./lib/cost.mjs";

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
  const results30 = (await ce.send(new GetCostAndUsageCommand(costQuery(window30)))).ResultsByTime ?? [];
  const results7 = (await ce.send(new GetCostAndUsageCommand(costQuery(window7)))).ResultsByTime ?? [];
  const last30 = summarise(results30, window30);
  const last7 = summarise(results7, window7);
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
    const path = join(repoRoot, "docs", "COST.md");
    const before = readFileSync(path, "utf8");
    const after = spliceNumbers(before, renderNumbersSection({ last7, last30, budget, now }));
    writeFileSync(path, after);
    console.error(`docs/COST.md: the numbers section ${after === before ? "is unchanged" : "was rewritten"}`);
  }
}

main().catch((error) => {
  console.error(`cost report failed: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
