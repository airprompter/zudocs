/**
 * Builds every stack on one app from one configuration — the single place the
 * stack ids, environments and inter-stack references are decided, shared by
 * the CDK entry point and the tests so what the tests pin is what deploys.
 *
 * Stack ids and what deploys them:
 *   ZudocsCi          the owner's session only (it is what CI assumes)
 *   ZudocsDns         the owner's session first (the registrar is repointed at its output), then CI
 *   ZudocsSite        CI (and the owner's session for the first deploy); needs `npm run build` since phase 8 (the cost check)
 *   ZudocsSharedHost  CI: the eu-west-1 host (the daemon, two workers, the wire function); needs `npm run build`
 *   ZudocsFleet       CI: the ap-southeast-1 puller, the releases table, the exchange bucket, the nudge queue; needs `npm run build`
 *   ZudocsDesk        CI (the desk API, its tables and key, the desk SPA); needs `npm run build` first. Ordered after
 *                     the shared host and the fleet (no reference crosses the regions, but its Budgets action names the
 *                     host's role, its function names the wire function and the nudge queue — all must exist first)
 *   ZudocsAirgap      the owner's session only, on demand (`npm run airgap:up` / `airgap:down`): the air-gapped host in
 *                     ap-southeast-1; never in CI's deploy list
 *
 * @example
 * ```ts
 * const app = new cdk.App();
 * const { dns, site, sharedHost, fleet, desk, airgap, ci } = buildStacks(app, readConfig(app.node));
 * // tests: buildStacks(app, config, { assets: { deskApi, deskSite, euHostBundle, wire, puller, airgapBundle }, airprompter: ids })
 * ```
 */
import type * as cdk from "aws-cdk-lib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AirgapStack } from "./airgap-stack.js";
import { CiStack } from "./ci-stack.js";
import type { ZudocsConfig } from "./config.js";
import { DeskStack, readAirPrompterIds, type AirPrompterIds } from "./desk-stack.js";
import { DnsStack } from "./dns-stack.js";
import type { AirgapPins } from "./fleet-names.js";
import { FleetStack } from "./fleet-stack.js";
import { SharedHostStack } from "./shared-host-stack.js";
import type { Pins } from "./shared-host-names.js";
import { SiteStack } from "./site-stack.js";

export const STACK_IDS = { ci: "ZudocsCi", dns: "ZudocsDns", site: "ZudocsSite", desk: "ZudocsDesk", sharedHost: "ZudocsSharedHost", fleet: "ZudocsFleet", airgap: "ZudocsAirgap" } as const;

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Where `npm run build` leaves the artefacts the stacks deploy. */
export const DEFAULT_ASSETS = Object.freeze({
  deskApi: join(repoRoot, "services", "desk-api", "dist"),
  deskSite: join(repoRoot, "apps", "desk", "dist"),
  euHostBundle: join(repoRoot, "services", "eu-host", "dist", "bundle"),
  wire: join(repoRoot, "services", "eu-host", "dist", "wire"),
  power: join(repoRoot, "services", "eu-host", "dist", "power"),
  puller: join(repoRoot, "services", "puller", "dist"),
  airgapBundle: join(repoRoot, "services", "airgap", "dist", "bundle"),
  costCheck: join(repoRoot, "services", "cost-check", "dist"),
});

export interface BuildOptions {
  readonly assets?: { readonly deskApi: string; readonly deskSite: string; readonly euHostBundle: string; readonly wire: string; readonly power: string; readonly puller: string; readonly airgapBundle: string; readonly costCheck: string };
  readonly airprompter?: AirPrompterIds;
  readonly pins?: Pins;
  readonly airgapPins?: AirgapPins;
}

export function buildStacks(app: cdk.App, config: ZudocsConfig, options: BuildOptions = {}): { ci: CiStack; dns: DnsStack; site: SiteStack; sharedHost: SharedHostStack; fleet: FleetStack; desk: DeskStack; airgap: AirgapStack } {
  const env = { account: config.account, region: config.regions.site };
  const tags = { Project: "zudocs", Purpose: "airprompter-demo" };
  const assets = options.assets ?? DEFAULT_ASSETS;
  const airprompter = options.airprompter ?? readAirPrompterIds();
  const ci = new CiStack(app, STACK_IDS.ci, { config, env, tags, description: "Zudocs: GitHub OIDC deploy role (deployed by the owner, never by CI)" });
  const dns = new DnsStack(app, STACK_IDS.dns, { config, env, tags, description: "Zudocs: the hosted zone and the root mailbox's records" });
  const site = new SiteStack(app, STACK_IDS.site, { config, zone: dns.zone, env, tags, assets: { costCheck: assets.costCheck }, description: "Zudocs: landing page, sign-in, budget, trail, the monthly cost check" });
  const sharedHost = new SharedHostStack(app, STACK_IDS.sharedHost, { config, env: { account: config.account, region: config.regions.sharedHost }, tags, assets: { euHostBundle: assets.euHostBundle, wire: assets.wire, power: assets.power }, airprompter, ...(options.pins ? { pins: options.pins } : {}), description: "Zudocs: the eu-west-1 shared host (airprompterd, a Node and a Python worker) and the wire function" });
  const fleetEnv = { account: config.account, region: config.regions.fleet };
  const fleet = new FleetStack(app, STACK_IDS.fleet, { config, env: fleetEnv, tags, assets: { puller: assets.puller }, airprompter, description: "Zudocs: the ap-southeast-1 fleet — the puller, the releases table, the exchange bucket, the nudge queue" });
  const desk = new DeskStack(app, STACK_IDS.desk, { config, site, zone: dns.zone, env, tags, assets: { deskApi: assets.deskApi, deskSite: assets.deskSite }, airprompter, description: "Zudocs: the desk API (the AirPrompter SDK on Lambda), its tables and key, the desk app" });
  desk.addStackDependency(sharedHost, "the Budgets action names the host's role and the function names the wire function; both exist first");
  desk.addStackDependency(fleet, "the presenter's nudge names the queue by its fixed name; it exists first");
  const airgap = new AirgapStack(app, STACK_IDS.airgap, { config, env: fleetEnv, tags, assets: { airgapBundle: assets.airgapBundle }, airprompter, ...(options.pins ? { pins: options.pins } : {}), ...(options.airgapPins ? { airgapPins: options.airgapPins } : {}), description: "Zudocs: the ap-southeast-1 air-gapped host (on demand; never deployed by CI)" });
  airgap.addStackDependency(fleet, "the host reads the exchange bucket and the releases table by their fixed names; both exist first");
  return { ci, dns, site, sharedHost, fleet, desk, airgap };
}
