/**
 * The stacks synthesize the shape the plan promises, and refuse the
 * configurations that would quietly weaken it.
 *
 * @example
 * ```sh
 * npx tsx --test test/stacks.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { readConfig } from "../lib/config.js";
import { CiStack } from "../lib/ci-stack.js";
import { SiteStack } from "../lib/site-stack.js";

const CONTEXT = {
  account: "111122223333",
  domain: "zudocs.com",
  regions: { site: "us-east-1", sharedHost: "eu-west-1", fleet: "ap-southeast-1" },
  github: { owner: "airprompter", repo: "zudocs", branch: "main" },
  budget: { monthlyUsd: 30, alertUsd: 50 },
};

function synth(email = "owner@example.test") {
  const app = new cdk.App({ context: CONTEXT });
  const config = readConfig(app.node, { BUDGET_EMAIL: email });
  const env = { account: config.account, region: config.regions.site };
  // Both stacks go on the tree before the first synth: a template after a synth is a modified tree.
  const site = new SiteStack(app, "Site", { config, env });
  const ci = new CiStack(app, "Ci", { config, env });
  return { site: Template.fromStack(site), ci: Template.fromStack(ci) };
}

test("config: an account id is required and the budget alert must exceed the monthly line", () => {
  const app = new cdk.App({ context: { ...CONTEXT, account: undefined } });
  assert.throws(() => readConfig(app.node, {}), /account id/, "no account anywhere");
  const bad = new cdk.App({ context: { ...CONTEXT, budget: { monthlyUsd: 30, alertUsd: 20 } } });
  assert.throws(() => readConfig(bad.node, {}), /alertUsd/, "alert below the line");
});

test("sign-in is owner-created only: no self-signup, no recovery, a public PKCE client with openid+email and no admin scope", () => {
  const { site } = synth();
  site.hasResourceProperties("AWS::Cognito::UserPool", { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }] } });
  site.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    AllowedOAuthFlows: ["code"],
    AllowedOAuthScopes: ["openid", "email"],
    CallbackURLs: Match.arrayWith(["https://desk.zudocs.com/callback"]),
  });
  const clients = site.findResources("AWS::Cognito::UserPoolClient");
  for (const client of Object.values(clients)) assert.ok(!JSON.stringify(client).includes("aws.cognito.signin.user.admin"), "the admin scope would let a signed-in user delete the login");
});

test("the landing page is private S3 behind CloudFront with strict headers, and the zone carries the root mailbox's MX and DKIM", () => {
  const { site } = synth();
  site.hasResourceProperties("AWS::S3::Bucket", { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
  site.hasResourceProperties("AWS::CloudFront::Distribution", { DistributionConfig: Match.objectLike({ Aliases: ["zudocs.com", "www.zudocs.com"], DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }) }) });
  site.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", { ResponseHeadersPolicyConfig: Match.objectLike({ SecurityHeadersConfig: Match.objectLike({ FrameOptions: { FrameOption: "DENY", Override: true } }) }) });
  site.hasResourceProperties("AWS::Route53::RecordSet", { Type: "MX", ResourceRecords: ["10 inbound-smtp.us-east-1.amazonaws.com"] });
  assert.equal(Object.keys(site.findResources("AWS::Route53::RecordSet", { Properties: { Type: "CNAME" } })).length, 3, "three DKIM CNAMEs");
});

test("money: a monthly budget with actual, alert and forecast notifications, a Bedrock deny policy ready for the action, a multi-region trail", () => {
  const { site } = synth();
  site.hasResourceProperties("AWS::Budgets::Budget", { Budget: Match.objectLike({ BudgetLimit: { Amount: 30, Unit: "USD" }, TimeUnit: "MONTHLY" }) });
  const [budget] = Object.values(site.findResources("AWS::Budgets::Budget"));
  assert.equal((budget as { Properties: { NotificationsWithSubscribers: unknown[] } }).Properties.NotificationsWithSubscribers.length, 3, "three notifications");
  site.hasResourceProperties("AWS::IAM::ManagedPolicy", { ManagedPolicyName: "ZudocsBudgetBedrockDeny", PolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Effect: "Deny", Action: Match.arrayWith(["bedrock:InvokeModel"]) })] }) });
  site.hasResourceProperties("AWS::CloudTrail::Trail", { IsMultiRegionTrail: true, EnableLogFileValidation: true });
  site.hasResourceProperties("AWS::CE::AnomalySubscription", { Subscribers: [{ Type: "EMAIL", Address: "owner@example.test" }] });
});

test("without a budget e-mail the stack still synthesizes (no recipient, no anomaly subscription) so a public checkout can synth", () => {
  const { site } = synth("");
  assert.equal(Object.keys(site.findResources("AWS::CE::AnomalySubscription")).length, 0);
  const [budget] = Object.values(site.findResources("AWS::Budgets::Budget"));
  assert.deepEqual((budget as { Properties: { NotificationsWithSubscribers: unknown[] } }).Properties.NotificationsWithSubscribers, []);
});

test("CI: the deploy role trusts one repository's main branch and may only assume the CDK bootstrap roles in the three regions", () => {
  const { ci } = synth();
  ci.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "zudocs-deploy",
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({ Condition: { StringEquals: Match.objectLike({ "token.actions.githubusercontent.com:sub": "repo:airprompter/zudocs:ref:refs/heads/main" }) } })],
    }),
  });
  ci.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({ Action: "sts:AssumeRole", Resource: Match.arrayWith(["arn:aws:iam::111122223333:role/cdk-hnb659fds-*-111122223333-ap-southeast-1"]) })],
    }),
  });
  const policies = JSON.stringify(ci.findResources("AWS::IAM::Policy"));
  assert.ok(!/"Action":\s*"\*"/.test(policies) && !policies.includes("AdministratorAccess"), "the deploy role is not an administrator");
});
