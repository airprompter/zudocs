#!/usr/bin/env node
/**
 * The teardown, owner-only: every Zudocs stack deleted in the order they can be (`lib/teardown.mjs`), then the list
 * of what CloudFormation leaves in the account — the retained zone, user pool and buckets, the SecureStrings the
 * owner wrote, the key pending deletion, the log groups nobody owned, the bootstrap, the OIDC provider — each with
 * the exact commands, and the reminders that live outside this account (the registrar, the SES forwarder in the
 * management account). `--dry-run` prints the plan against the live account and deletes nothing. A live run asks
 * for the account id typed in full before the first delete, and deletes straight through CloudFormation
 * (`DeleteStack` + wait), so it needs no built assets, no synth, no BUDGET_EMAIL — and it never runs from CI.
 *
 * @example
 * ```sh
 * AWS_PROFILE=zudocs npm run teardown -- --dry-run     # the plan, read-only
 * AWS_PROFILE=zudocs npm run teardown                  # type the account id when asked; ~25 minutes
 * ```
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand, waitUntilStackDeleteComplete } from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { TEARDOWN_ORDER, leftovers, renderPlan } from "./lib/teardown.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const clients = new Map();
const cfn = (region) => {
  if (!clients.has(region)) clients.set(region, new CloudFormationClient({ region }));
  return clients.get(region);
};

async function describe(stack, region) {
  try {
    const out = await cfn(region).send(new DescribeStacksCommand({ StackName: stack }));
    const s = out.Stacks?.[0];
    if (!s) return null;
    return { status: s.StackStatus, outputs: Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])) };
  } catch (error) {
    if (/does not exist/.test(String(error.message))) return null;
    throw error;
  }
}

async function main() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) throw new Error("the teardown never runs from CI");
  const account = (await new STSClient({ region: "us-east-1" }).send(new GetCallerIdentityCommand({}))).Account;
  const found = {};
  const outputs = {};
  for (const step of TEARDOWN_ORDER) {
    const d = await describe(step.stack, step.region);
    if (d) {
      found[step.stack] = d;
      outputs[step.stack] = d.outputs;
    }
  }
  const left = leftovers({ account, outputs });
  process.stdout.write(renderPlan({ account, found, leftovers: left, dryRun }));
  if (dryRun) return;
  const present = TEARDOWN_ORDER.filter((s) => found[s.stack]);
  if (present.length === 0) {
    console.log("no Zudocs stack is deployed in this account; only the list above remains");
    return;
  }
  if (!stdin.isTTY) throw new Error("a live teardown needs a terminal to confirm in (use --dry-run otherwise)");
  const rl = createInterface({ input: stdin, output: stdout });
  const typed = (await rl.question(`Delete ${present.length} stack(s) in account ${account}? Type the account id to confirm: `)).trim();
  rl.close();
  if (typed !== account) throw new Error("the account id did not match; nothing was deleted");
  for (const step of present) {
    const started = Date.now();
    console.log(`deleting ${step.stack} (${step.region})…`);
    await cfn(step.region).send(new DeleteStackCommand({ StackName: step.stack }));
    await waitUntilStackDeleteComplete({ client: cfn(step.region), maxWaitTime: 1800, minDelay: 15 }, { StackName: step.stack });
    console.log(`  ${step.stack} deleted in ${Math.round((Date.now() - started) / 1000)} s`);
  }
  console.log("\nevery stack is gone; now the list above, by hand, in order");
}

main().catch((error) => {
  console.error(`teardown: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
