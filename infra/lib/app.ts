/**
 * Builds every stack on one app from one configuration — the single place the
 * stack ids, environments and inter-stack references are decided, shared by
 * the CDK entry point and the tests so what the tests pin is what deploys.
 *
 * Stack ids and what deploys them:
 *   ZudocsCi    the owner's session only (it is what CI assumes)
 *   ZudocsDns   the owner's session first (the registrar is repointed at its output), then CI
 *   ZudocsSite  CI (and the owner's session for the first deploy)
 *
 * @example
 * ```ts
 * const app = new cdk.App();
 * const { dns, site, ci } = buildStacks(app, readConfig(app.node));
 * ```
 */
import type * as cdk from "aws-cdk-lib";
import { CiStack } from "./ci-stack.js";
import type { ZudocsConfig } from "./config.js";
import { DnsStack } from "./dns-stack.js";
import { SiteStack } from "./site-stack.js";

export const STACK_IDS = { ci: "ZudocsCi", dns: "ZudocsDns", site: "ZudocsSite" } as const;

export function buildStacks(app: cdk.App, config: ZudocsConfig): { ci: CiStack; dns: DnsStack; site: SiteStack } {
  const env = { account: config.account, region: config.regions.site };
  const tags = { Project: "zudocs", Purpose: "airprompter-demo" };
  const ci = new CiStack(app, STACK_IDS.ci, { config, env, tags, description: "Zudocs: GitHub OIDC deploy role (deployed by the owner, never by CI)" });
  const dns = new DnsStack(app, STACK_IDS.dns, { config, env, tags, description: "Zudocs: the hosted zone and the root mailbox's records" });
  const site = new SiteStack(app, STACK_IDS.site, { config, zone: dns.zone, env, tags, description: "Zudocs: landing page, sign-in, budget, trail" });
  return { ci, dns, site };
}
