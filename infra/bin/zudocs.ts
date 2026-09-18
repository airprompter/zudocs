#!/usr/bin/env node
/**
 * The CDK entry point: read the configuration, build the stacks.
 *
 * Phase 1 deploys `ZudocsCi`, `ZudocsDns` and `ZudocsSite` in us-east-1 (see
 * `lib/app.ts` for who deploys which). Later phases add `ZudocsSharedHost`
 * (eu-west-1), `ZudocsFleet` (ap-southeast-1) and the on-demand `ZudocsAirgap`.
 *
 * @example
 * ```sh
 * npx cdk synth --quiet --context account=111122223333 --context allowNoBudgetEmail=true   # no credentials
 * AWS_PROFILE=zudocs BUDGET_EMAIL=billing@example.test npx cdk deploy ZudocsCi ZudocsDns
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { buildStacks } from "../lib/app.js";
import { readConfig } from "../lib/config.js";

const app = new cdk.App();
buildStacks(app, readConfig(app.node));
