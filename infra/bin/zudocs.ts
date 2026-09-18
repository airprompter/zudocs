#!/usr/bin/env node
/**
 * The CDK app: one stack per region plus the CI stack, all from one configuration.
 *
 * Phase 1 deploys `ZudocsSite` and `ZudocsCi` in us-east-1. Later phases add
 * `ZudocsSharedHost` (eu-west-1), `ZudocsFleet` (ap-southeast-1) and the
 * on-demand `ZudocsAirgap`.
 *
 * @example
 * ```sh
 * npx cdk synth --quiet                          # no credentials: --context account=123456789012
 * AWS_PROFILE=zudocs npx cdk deploy ZudocsCi ZudocsSite
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { readConfig } from "../lib/config.js";
import { CiStack } from "../lib/ci-stack.js";
import { SiteStack } from "../lib/site-stack.js";

const app = new cdk.App();
const config = readConfig(app.node);
const tags = { Project: "zudocs", Purpose: "airprompter-demo" };

new CiStack(app, "ZudocsCi", { config, env: { account: config.account, region: config.regions.site }, tags, description: "Zudocs: GitHub OIDC deploy role" });
new SiteStack(app, "ZudocsSite", { config, env: { account: config.account, region: config.regions.site }, tags, description: "Zudocs: DNS, landing page, sign-in, budget, trail" });
