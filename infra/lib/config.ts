/**
 * The Zudocs deployment's configuration: everything that is not a secret and
 * not derived from the code, read once from CDK context (`cdk.json`) and the
 * environment, validated, and handed to the stacks as one frozen object.
 *
 * Secrets are never here. The Agent keys and the run key live in SSM as
 * SecureStrings, written by the owner and read by the runtimes at cold start.
 * The budget e-mail is the one environment read at synth time (it is an
 * address, not a secret, and a public repository still should not carry it);
 * it is required, so a deploy cannot quietly ship a budget nobody hears from —
 * only a credential-less synth may waive it (`--context allowNoBudgetEmail=true`).
 *
 * @example
 * ```ts
 * const config = readConfig(app.node);          // throws with the missing key named
 * new SiteStack(app, "ZudocsSite", { config, zone, env: { account: config.account, region: config.regions.site } });
 * ```
 */
import type { Node } from "constructs";

export interface ZudocsConfig {
  /** The AWS account the demo company lives in (CDK_DEFAULT_ACCOUNT, or `--context account=`). */
  readonly account: string;
  /** The apex domain; the landing page sits on it, the desk on `desk.` under it. */
  readonly domain: string;
  readonly regions: {
    /** us-east-1: the site, sign-in, the desk API, CloudFront's certificate. */
    readonly site: string;
    /** eu-west-1: the shared host with the daemon and two workers. */
    readonly sharedHost: string;
    /** ap-southeast-1: the puller, the exchange bucket, the air-gapped host. */
    readonly fleet: string;
  };
  readonly github: { readonly owner: string; readonly repo: string; readonly branch: string };
  readonly budget: {
    /** Where the monthly budget is drawn (the Bedrock deny action fires here in phase 3). */
    readonly monthlyUsd: number;
    /** A second, louder alert. */
    readonly alertUsd: number;
    /** BUDGET_EMAIL in the environment; empty only when `allowNoBudgetEmail` was passed. */
    readonly email: string;
  };
  /**
   * SES inbound for the root mailbox: the domain's mail is received by SES in the
   * organisation's management account and forwarded to the owner. The DKIM tokens are
   * public DNS by nature (every signed mail names its selector) and live in `cdk.json`.
   */
  readonly mail: { readonly inboundRegion: string; readonly dkimTokens: readonly string[] };
}

export function readConfig(node: Node, env: NodeJS.ProcessEnv = process.env): ZudocsConfig {
  const account = (node.tryGetContext("account") as string | undefined) ?? env.CDK_DEFAULT_ACCOUNT;
  if (!account || !/^\d{12}$/.test(account)) throw new Error("config: an account id is needed (CDK_DEFAULT_ACCOUNT from the profile, or --context account=…)");
  const domain = need<string>(node, "domain");
  const regions = need<ZudocsConfig["regions"]>(node, "regions");
  const github = need<ZudocsConfig["github"]>(node, "github");
  const budget = need<{ monthlyUsd: number; alertUsd: number }>(node, "budget");
  const mail = need<{ inboundRegion: string; dkimTokens: string[] }>(node, "mail");
  for (const [key, value] of Object.entries(regions)) if (!/^[a-z]{2}-[a-z]+-\d$/.test(value)) throw new Error(`config: regions.${key} is not a region: ${value}`);
  if (!(budget.monthlyUsd > 0 && budget.alertUsd > budget.monthlyUsd)) throw new Error("config: budget.alertUsd must exceed budget.monthlyUsd, both positive");
  if (!Array.isArray(mail.dkimTokens) || mail.dkimTokens.length !== 3 || !mail.dkimTokens.every((t) => /^[a-z0-9]{32}$/.test(t))) throw new Error("config: mail.dkimTokens must be the three 32-character SES DKIM tokens");
  const email = env.BUDGET_EMAIL ?? "";
  const waived = String(node.tryGetContext("allowNoBudgetEmail")) === "true";
  if (!email && !waived) throw new Error("config: BUDGET_EMAIL is required so the budget has a recipient (a credential-less synth may pass --context allowNoBudgetEmail=true)");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("config: BUDGET_EMAIL is not an e-mail address");
  return Object.freeze({
    account,
    domain,
    regions: Object.freeze({ ...regions }),
    github: Object.freeze({ ...github }),
    budget: Object.freeze({ ...budget, email }),
    mail: Object.freeze({ inboundRegion: mail.inboundRegion, dkimTokens: Object.freeze([...mail.dkimTokens]) }),
  });
}

function need<T>(node: Node, key: string): T {
  const value = node.tryGetContext(key) as T | undefined;
  if (value === undefined || value === null) throw new Error(`config: cdk.json context "${key}" is missing`);
  return value;
}
