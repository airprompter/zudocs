/**
 * Builds every stack on one app from one configuration — the single place the
 * stack ids, environments and inter-stack references are decided, shared by
 * the CDK entry point and the tests so what the tests pin is what deploys.
 *
 * Stack ids and what deploys them:
 *   ZudocsCi    the owner's session only (it is what CI assumes)
 *   ZudocsDns   the owner's session first (the registrar is repointed at its output), then CI
 *   ZudocsSite  CI (and the owner's session for the first deploy)
 *   ZudocsDesk  CI (the desk API, its tables and key, the desk SPA); needs `npm run build` first
 *
 * @example
 * ```ts
 * const app = new cdk.App();
 * const { dns, site, desk, ci } = buildStacks(app, readConfig(app.node));
 * // tests: buildStacks(app, config, { assets: { deskApi: fixtureDir, deskSite: fixtureDir }, airprompter: ids })
 * ```
 */
import type * as cdk from "aws-cdk-lib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CiStack } from "./ci-stack.js";
import type { ZudocsConfig } from "./config.js";
import { DeskStack, readAirPrompterIds, type AirPrompterIds } from "./desk-stack.js";
import { DnsStack } from "./dns-stack.js";
import { SiteStack } from "./site-stack.js";

export const STACK_IDS = { ci: "ZudocsCi", dns: "ZudocsDns", site: "ZudocsSite", desk: "ZudocsDesk" } as const;

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Where `npm run build` leaves the artefacts the desk stack deploys. */
export const DEFAULT_ASSETS = Object.freeze({ deskApi: join(repoRoot, "services", "desk-api", "dist"), deskSite: join(repoRoot, "apps", "desk", "dist") });

export interface BuildOptions {
  readonly assets?: { readonly deskApi: string; readonly deskSite: string };
  readonly airprompter?: AirPrompterIds;
}

export function buildStacks(app: cdk.App, config: ZudocsConfig, options: BuildOptions = {}): { ci: CiStack; dns: DnsStack; site: SiteStack; desk: DeskStack } {
  const env = { account: config.account, region: config.regions.site };
  const tags = { Project: "zudocs", Purpose: "airprompter-demo" };
  const ci = new CiStack(app, STACK_IDS.ci, { config, env, tags, description: "Zudocs: GitHub OIDC deploy role (deployed by the owner, never by CI)" });
  const dns = new DnsStack(app, STACK_IDS.dns, { config, env, tags, description: "Zudocs: the hosted zone and the root mailbox's records" });
  const site = new SiteStack(app, STACK_IDS.site, { config, zone: dns.zone, env, tags, description: "Zudocs: landing page, sign-in, budget, trail" });
  const desk = new DeskStack(app, STACK_IDS.desk, { config, site, zone: dns.zone, env, tags, assets: options.assets ?? DEFAULT_ASSETS, airprompter: options.airprompter ?? readAirPrompterIds(), description: "Zudocs: the desk API (the AirPrompter SDK on Lambda), its tables and key, the desk app" });
  return { ci, dns, site, desk };
}
