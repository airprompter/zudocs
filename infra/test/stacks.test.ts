/**
 * The stacks synthesize the shape the plan promises, and refuse the
 * configurations that would quietly weaken it. Built through `buildStacks`,
 * so the ids and references pinned here are the ones that deploy.
 *
 * @example
 * ```sh
 * npx tsx --test test/stacks.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import { STACK_IDS } from "../lib/app.js";
import { readConfig } from "../lib/config.js";
import { cognitoDomainPrefix } from "../lib/site-stack.js";
import { CONTEXT, synthAll } from "./fixtures.js";

const synth = synthAll;

type Resources = Record<string, { Properties: Record<string, unknown> }>;

test("config refuses what would weaken the deploy: no account, an alert below the line, bad DKIM tokens, no budget e-mail unless waived", () => {
  assert.throws(() => readConfig(new cdk.App({ context: { ...CONTEXT, account: undefined } }).node, { BUDGET_EMAIL: "x@y.z" }), /account id/);
  assert.throws(() => readConfig(new cdk.App({ context: { ...CONTEXT, budget: { monthlyUsd: 30, alertUsd: 20 } } }).node, { BUDGET_EMAIL: "x@y.z" }), /alertUsd/);
  assert.throws(() => readConfig(new cdk.App({ context: { ...CONTEXT, mail: { inboundRegion: "us-east-1", dkimTokens: ["short"] } } }).node, { BUDGET_EMAIL: "x@y.z" }), /dkimTokens/);
  assert.throws(() => readConfig(new cdk.App({ context: { ...CONTEXT, github: { ...CONTEXT.github, repoId: 0 } } }).node, { BUDGET_EMAIL: "x@y.z" }), /repoId/, "the immutable subject needs the ids");
  assert.throws(() => readConfig(new cdk.App({ context: CONTEXT }).node, {}), /BUDGET_EMAIL/, "a deploy without a recipient is refused");
  assert.throws(() => readConfig(new cdk.App({ context: CONTEXT }).node, { BUDGET_EMAIL: "not-an-address" }), /e-mail/);
  assert.equal(readConfig(new cdk.App({ context: { ...CONTEXT, allowNoBudgetEmail: "true" } }).node, {}).budget.email, "", "the credential-less synth may waive it");
});

test("the stack ids are the ones the workflow names, and the site depends on the DNS stack's zone", () => {
  const { stacks } = synth();
  assert.deepEqual(Object.values(STACK_IDS).sort(), ["ZudocsAirgap", "ZudocsCi", "ZudocsDesk", "ZudocsDns", "ZudocsFleet", "ZudocsSharedHost", "ZudocsSite"]);
  assert.ok(stacks.site.dependencies.includes(stacks.dns), "the site's certificate validates through the zone");
  assert.ok(!stacks.ci.dependencies.length && !stacks.dns.dependencies.includes(stacks.ci) && !stacks.site.dependencies.includes(stacks.ci), "CI is deployed alone, by the owner");
});

test("DNS: the zone is retained and carries the root mailbox's MX and three DKIM CNAMEs; the site's certificate covers apex, www and desk", () => {
  const { dns, site } = synth();
  dns.hasResource("AWS::Route53::HostedZone", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  dns.hasResourceProperties("AWS::Route53::RecordSet", { Type: "MX", ResourceRecords: ["10 inbound-smtp.us-east-1.amazonaws.com"] });
  assert.equal(Object.keys(dns.findResources("AWS::Route53::RecordSet", { Properties: { Type: "CNAME" } })).length, 3, "three DKIM CNAMEs");
  dns.hasOutput("NameServers", {});
  site.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "zudocs.com", SubjectAlternativeNames: ["www.zudocs.com", "desk.zudocs.com"], ValidationMethod: "DNS" });
});

test("the landing page: every bucket blocks public access, the origin may only GetObject for this distribution, missing keys (403 and 404) reach the 404 page, strict headers", () => {
  const { site } = synth();
  const buckets = site.findResources("AWS::S3::Bucket") as Resources;
  assert.equal(Object.keys(buckets).length, 2, "the site bucket and the trail bucket");
  for (const [id, bucket] of Object.entries(buckets)) {
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, id);
  }
  type Statement = { Action: unknown; Principal?: { Service?: string }; Condition?: Record<string, unknown> };
  const statements = Object.values(site.findResources("AWS::S3::BucketPolicy") as Resources).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  const cloudfront = statements.filter((st) => st.Principal?.Service === "cloudfront.amazonaws.com");
  assert.equal(cloudfront.length, 1, "one statement for CloudFront");
  assert.equal(cloudfront[0]!.Action, "s3:GetObject", "the origin may only GetObject: a missing key is a 403 from S3");
  assert.ok(JSON.stringify(cloudfront[0]!.Condition).includes("AWS:SourceArn"), "bound to this distribution");
  site.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      Aliases: ["zudocs.com", "www.zudocs.com"],
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({ ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html" }),
        Match.objectLike({ ErrorCode: 404, ResponseCode: 404, ResponsePagePath: "/404.html" }),
      ]),
    }),
  });
  site.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
    ResponseHeadersPolicyConfig: Match.objectLike({
      SecurityHeadersConfig: Match.objectLike({
        FrameOptions: { FrameOption: "DENY", Override: true },
        ContentSecurityPolicy: { ContentSecurityPolicy: Match.stringLikeRegexp("^default-src 'self'; .*frame-ancestors 'none'$"), Override: true },
      }),
    }),
  });
  assert.ok(!JSON.stringify(site.findResources("AWS::CloudFront::ResponseHeadersPolicy")).includes("unsafe-inline"), "the page has no inline style or script");
});

test("sign-in is owner-created only: no self-signup, no recovery, hosted UI with a public PKCE client scoped to openid+email, no admin scope, no password flow", () => {
  const { site } = synth();
  site.hasResourceProperties("AWS::Cognito::UserPool", { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }] } });
  site.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    AllowedOAuthFlows: ["code"],
    AllowedOAuthScopes: ["openid", "email"],
    CallbackURLs: Match.arrayWith(["https://desk.zudocs.com/callback"]),
  });
  const clients = JSON.stringify(site.findResources("AWS::Cognito::UserPoolClient"));
  assert.ok(!clients.includes("aws.cognito.signin.user.admin"), "the admin scope would let a signed-in user delete the login");
  // Positively: an absent ExplicitAuthFlows would mean Cognito's defaults (SRP + custom auth), not "none".
  site.hasResourceProperties("AWS::Cognito::UserPoolClient", { ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"] });
  site.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: cognitoDomainPrefix("111122223333") });
  assert.match(cognitoDomainPrefix("111122223333"), /^zudocs-[0-9a-f]{8}$/, "a valid, account-derived prefix that is not the account id");
  assert.notEqual(cognitoDomainPrefix("111122223333"), cognitoDomainPrefix("444455556666"));
});

test("money: a $30 budget with [actual 100 %, actual 166.67 %, forecast 100 %] to the recipient, the Bedrock deny policy ready for the action, an anomaly monitor, a multi-region trail", () => {
  const { site } = synth();
  const [budget] = Object.values(site.findResources("AWS::Budgets::Budget") as Resources);
  assert.ok(budget, "one budget");
  const props = budget.Properties as { Budget: { BudgetLimit: unknown; TimeUnit: string }; NotificationsWithSubscribers: Array<{ Notification: Record<string, unknown>; Subscribers: unknown[] }> };
  assert.deepEqual(props.Budget.BudgetLimit, { Amount: 30, Unit: "USD" });
  assert.equal(props.Budget.TimeUnit, "MONTHLY");
  assert.deepEqual(
    props.NotificationsWithSubscribers.map((n) => [n.Notification.NotificationType, n.Notification.Threshold]),
    [["ACTUAL", 100], ["ACTUAL", 166.67], ["FORECASTED", 100]],
  );
  for (const n of props.NotificationsWithSubscribers) assert.deepEqual(n.Subscribers, [{ SubscriptionType: "EMAIL", Address: "owner@example.test" }]);
  site.hasResourceProperties("AWS::IAM::ManagedPolicy", { ManagedPolicyName: "ZudocsBudgetBedrockDeny", PolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Effect: "Deny", Action: ["bedrock-mantle:*", "bedrock:Converse", "bedrock:ConverseStream", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"] })] }) });
  site.hasResourceProperties("AWS::CE::AnomalySubscription", { Frequency: "DAILY", Subscribers: [{ Type: "EMAIL", Address: "owner@example.test" }] });
  site.hasResourceProperties("AWS::CloudTrail::Trail", { IsMultiRegionTrail: true, EnableLogFileValidation: true, IncludeGlobalServiceEvents: true });
});

test("without a budget e-mail (waived) the stacks still synthesize: no notifications property at all, no anomaly subscription", () => {
  const { site } = synth("", { allowNoBudgetEmail: "true" });
  assert.equal(Object.keys(site.findResources("AWS::CE::AnomalySubscription")).length, 0);
  const [budget] = Object.values(site.findResources("AWS::Budgets::Budget") as Resources);
  assert.ok(budget && !("NotificationsWithSubscribers" in budget.Properties), "absent, not an empty list");
});

test("CI: an existing GitHub OIDC provider is imported rather than created when its ARN is in context", () => {
  const { ci } = synth("owner@example.test", { githubOidcProviderArn: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" });
  ci.resourceCountIs("AWS::IAM::OIDCProvider", 0);
  ci.hasResourceProperties("AWS::IAM::Role", { AssumeRolePolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Principal: { Federated: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" } })] }) });
});

test("CI: a native OIDC provider; the deploy role trusts one repository's main branch (immutable subject: owner and repo ids) with the sts audience, holds no managed policy, and may only assume the CDK bootstrap roles in the three regions", () => {
  const { ci } = synth();
  ci.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  assert.equal(Object.keys(ci.findResources("Custom::AWSCDKOpenIdConnectProvider")).length, 0, "no custom resource, no unverified thumbprint fetch");
  ci.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "zudocs-deploy",
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": "repo:airprompter@295734781/zudocs@1375253396:ref:refs/heads/main" } },
      })],
    }),
  });
  const [role] = Object.values(ci.findResources("AWS::IAM::Role", { Properties: { RoleName: "zudocs-deploy" } }) as Resources);
  assert.ok(role && !("ManagedPolicyArns" in role.Properties), "no managed policy on the deploy role");
  const policies = Object.values(ci.findResources("AWS::IAM::Policy") as Resources);
  assert.equal(policies.length, 1, "one inline policy");
  const statements = (policies[0]!.Properties.PolicyDocument as { Statement: Array<{ Action: unknown; Resource: string[] }> }).Statement;
  assert.deepEqual(statements.map((s) => s.Action), ["sts:AssumeRole"], "the only action");
  assert.deepEqual([...statements[0]!.Resource].sort(), ["us-east-1", "eu-west-1", "ap-southeast-1"].map((r) => `arn:aws:iam::111122223333:role/cdk-hnb659fds-*-111122223333-${r}`).sort());
});
