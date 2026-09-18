/**
 * The Zudocs deployment's configuration: everything that is not a secret and
 * not derived from the code, read once from CDK context (`cdk.json`) and the
 * environment, validated, and handed to the stacks as one frozen object.
 *
 * Secrets are never here. The Agent keys and the run key live in SSM as
 * SecureStrings, written by the owner and read by the runtimes at cold start;
 * the budget e-mail comes from an environment variable so a public repository
 * carries no address.
 *
 * @example
 * ```ts
 * const config = readConfig(app.node);          // throws with the missing key named
 * new SiteStack(app, "ZudocsSite", { config, env: { account: config.account, region: config.regions.site } });
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
    /** BUDGET_EMAIL in the environment; empty means no e-mail recipient (synth still works). */
    readonly email: string;
  };
  /**
   * SES inbound for the root mailbox: the domain's mail is received by SES in the
   * organisation's management account and forwarded to the owner. The DKIM tokens are
   * public DNS by nature; they are what the management account's identity was issued.
   */
  readonly mail: { readonly inboundRegion: string; readonly dkimTokens: readonly string[] };
}

const DKIM_TOKENS = ["yywsavox55jeaij2szsxv4owcw7vyrme", "u62r4hfc5j7f36dvkd2dfhlxcz7e7fcl", "trx6ezrc42kytguaryejh6o2q7o6s6y3"] as const;

export function readConfig(node: Node, env: NodeJS.ProcessEnv = process.env): ZudocsConfig {
  const account = (node.tryGetContext("account") as string | undefined) ?? env.CDK_DEFAULT_ACCOUNT;
  if (!account || !/^\d{12}$/.test(account)) throw new Error("config: an account id is needed (CDK_DEFAULT_ACCOUNT from the profile, or --context account=…)");
  const domain = need<string>(node, "domain");
  const regions = need<ZudocsConfig["regions"]>(node, "regions");
  const github = need<ZudocsConfig["github"]>(node, "github");
  const budget = need<{ monthlyUsd: number; alertUsd: number }>(node, "budget");
  for (const [key, value] of Object.entries(regions)) if (!/^[a-z]{2}-[a-z]+-\d$/.test(value)) throw new Error(`config: regions.${key} is not a region: ${value}`);
  if (!(budget.monthlyUsd > 0 && budget.alertUsd > budget.monthlyUsd)) throw new Error("config: budget.alertUsd must exceed budget.monthlyUsd, both positive");
  return Object.freeze({
    account,
    domain,
    regions: Object.freeze({ ...regions }),
    github: Object.freeze({ ...github }),
    budget: Object.freeze({ ...budget, email: env.BUDGET_EMAIL ?? "" }),
    mail: Object.freeze({ inboundRegion: "us-east-1", dkimTokens: DKIM_TOKENS }),
  });
}

function need<T>(node: Node, key: string): T {
  const value = node.tryGetContext(key) as T | undefined;
  if (value === undefined || value === null) throw new Error(`config: cdk.json context "${key}" is missing`);
  return value;
}
