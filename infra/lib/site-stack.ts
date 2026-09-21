/**
 * The us-east-1 site stack: the company's public face and its account hygiene.
 *
 * - The landing page: a private S3 bucket behind CloudFront with an origin
 *   access control, the certificate for the apex, `www.` and `desk.` (validated
 *   through the zone `ZudocsDns` created and the registrar already points at).
 * - Sign-in for the desk: a Cognito user pool with no self-signup, no account
 *   recovery, hosted UI only, a public PKCE client scoped to `openid email` —
 *   users are created by hand (`admin-create-user`) for the owner today and
 *   sales people later. A second client, `proof`, has no hosted UI and allows
 *   the server-side password flow only: the automated proof signs in as
 *   `proof@zudocs.com` with a password that lives in the owner's environment.
 * - The monthly budget (e-mail alerts; the Bedrock deny action attaches to the
 *   runtime roles in phase 3), a management-events trail, and a cost anomaly
 *   monitor. The IAM policy the budget action will attach exists from day one.
 * - Phase 8: the **monthly cost check** — a small Lambda (`services/cost-check`)
 *   an EventBridge Scheduler schedule invokes on the third of the month; it runs
 *   the same Cost Explorer query as `npm run cost:report`, files `cost/YYYY-MM.json`
 *   in the trail bucket (whose expiry rule now covers the trail's own prefix only,
 *   so the record outlives the trail's ninety days) and puts `Zudocs/Cost` metrics.
 *   Its IAM: Cost Explorer reads, one budget, one metric namespace, one prefix.
 *
 * @example
 * ```ts
 * new SiteStack(app, "ZudocsSite", { config, zone: dns.zone, env: { account: config.account, region: config.regions.site }, assets: { costCheck: "…/services/cost-check/dist" } });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_budgets as budgets, aws_ce as ce, aws_certificatemanager as acm, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_cloudtrail as cloudtrail, aws_cognito as cognito, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_route53 as route53, aws_route53_targets as targets, aws_s3 as s3, aws_s3_deployment as deploy, aws_scheduler as scheduler } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ZudocsConfig } from "./config.js";

export interface SiteStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
  /** The zone from `ZudocsDns`; the certificate validates through it. */
  readonly zone: route53.IHostedZone;
  /** Built artefacts: the bundled cost-check function (`services/cost-check/dist`). */
  readonly assets: { readonly costCheck: string };
}

/** The monthly budget's name: the desk stack's Bedrock deny action is attached to it by name. */
export const BUDGET_NAME = "zudocs-monthly";
export const COST_CHECK_FUNCTION_NAME = "zudocs-cost-check";
export const COST_CHECK_SCHEDULE_NAME = "zudocs-cost-check-monthly";
/** The third of every month at 06:00 UTC: Cost Explorer settles a day about a day late, so by the third every day of the previous month is in. */
export const COST_CHECK_CRON_UTC = "cron(0 6 3 * ? *)";
/** Where the monthly documents go in the trail bucket (outside the trail's own `AWSLogs/` prefix and its expiry). */
export const COST_PREFIX = "cost/";
export const COST_METRIC_NAMESPACE = "Zudocs/Cost";
/** The management-events trail's bucket, exported for the teardown's list of what outlives the stacks. */
export const TRAIL_PREFIX = "AWSLogs/";

/** The Cognito hosted-UI prefix is unique per region across all accounts, so it is derived from ours (never the id itself). */
export function cognitoDomainPrefix(account: string): string {
  return `zudocs-${createHash("sha256").update(account).digest("hex").slice(0, 8)}`;
}

export class SiteStack extends cdk.Stack {
  readonly certificate: acm.Certificate;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  /** The hosted UI's domain (the desk's sign-in and token endpoints live under it). */
  readonly hostedUiDomain: cognito.UserPoolDomain;
  /** The proof script's client: ADMIN_USER_PASSWORD_AUTH only, no hosted UI, no secret. */
  readonly proofClient: cognito.UserPoolClient;
  /** Attached to every runtime role by the budget action when spend crosses the monthly line. */
  readonly bedrockDenyPolicy: iam.ManagedPolicy;
  /** The trail's bucket (RETAIN): the trail's own objects under `AWSLogs/`, the monthly cost documents under `cost/`. */
  readonly trailBucket: s3.Bucket;
  readonly costCheck: lambda.Function;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);
    const { config, zone } = props;
    const { domain } = config;
    for (const [name, path] of Object.entries(props.assets)) if (!existsSync(path)) throw new Error(`site stack: the ${name} artefact is missing at ${path} — run \`npm run build\` first`);

    // --- Certificate (CloudFront needs it in us-east-1) --------------------------------------
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: domain,
      subjectAlternativeNames: [`www.${domain}`, `desk.${domain}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // --- Landing page -------------------------------------------------------------------------
    const site = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const headers = new cloudfront.ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        // The page has no inline style or script and fetches nothing from anywhere else.
        contentSecurityPolicy: { contentSecurityPolicy: "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'", override: true },
      },
    });
    const distribution = new cloudfront.Distribution(this, "Landing", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      domainNames: [domain, `www.${domain}`],
      certificate: this.certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // The origin may only GetObject, so a missing key is a 403 from S3, not a 404: both map to the page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: cdk.Duration.minutes(5) },
      ],
      comment: `${domain} landing page`,
    });
    new deploy.BucketDeployment(this, "LandingFiles", {
      sources: [deploy.Source.asset(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "apps", "landing"), { exclude: [".*"] })],
      destinationBucket: site,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });
    for (const [name, recordName] of [["Apex", undefined], ["Www", "www"]] as const) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, `${name}A`, { zone, ...(recordName ? { recordName } : {}), target });
      new route53.AaaaRecord(this, `${name}Aaaa`, { zone, ...(recordName ? { recordName } : {}), target });
    }
    new cdk.CfnOutput(this, "LandingUrl", { value: `https://${domain}` });

    // --- Sign-in ------------------------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, "Users", {
      userPoolName: "zudocs-desk",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: { minLength: 14, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const hosted = this.userPool.addDomain("HostedUi", { cognitoDomain: { domainPrefix: cognitoDomainPrefix(config.account) } });
    this.hostedUiDomain = hosted;
    this.userPoolClient = this.userPool.addClient("Desk", {
      userPoolClientName: "desk",
      generateSecret: false,
      // Hosted UI with PKCE only. An empty object would leave Cognito's defaults (SRP + custom auth) in
      // place; naming userSrp false yields the refresh-token flow alone.
      authFlows: { userSrp: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        // The localhost callback is the desk's Vite dev server; it is the same client on purpose so a
        // laptop exercises the real pool (the user pool holds nothing but the owner's own login).
        callbackUrls: [`https://desk.${domain}/callback`, "http://localhost:5173/callback"],
        logoutUrls: [`https://desk.${domain}/`, "http://localhost:5173/"],
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.hours(24),
    });
    this.proofClient = this.userPool.addClient("Proof", {
      userPoolClientName: "proof",
      generateSecret: false,
      // The automated proof only: a server-side password sign-in the owner's session performs with the proof user's
      // password from its environment. No hosted UI, no OAuth flow, no callback — nothing a browser could use.
      authFlows: { adminUserPassword: true, userSrp: false },
      disableOAuth: true,
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.hours(1),
    });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "ProofClientId", { value: this.proofClient.userPoolClientId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "HostedUiBase", { value: hosted.baseUrl() });

    // --- Money and audit ----------------------------------------------------------------------
    this.bedrockDenyPolicy = new iam.ManagedPolicy(this, "BedrockDeny", {
      managedPolicyName: "ZudocsBudgetBedrockDeny",
      description: "Attached by the budget action when the month's spend crosses the line: no more model calls",
      statements: [new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream", "bedrock-mantle:*"], resources: ["*"] })],
    });
    const subscribers = config.budget.email ? [{ subscriptionType: "EMAIL", address: config.budget.email }] : [];
    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: BUDGET_NAME,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.budget.monthlyUsd, unit: "USD" },
      },
      notificationsWithSubscribers: subscribers.length
        ? [
            { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
            { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: Math.round((config.budget.alertUsd / config.budget.monthlyUsd) * 10000) / 100, thresholdType: "PERCENTAGE" }, subscribers },
            { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
          ]
        : undefined,
    });
    if (config.budget.email) {
      // One DIMENSIONAL/SERVICE monitor is allowed per account; this is it — a hand-made one fails this deploy.
      const monitor = new ce.CfnAnomalyMonitor(this, "AnomalyMonitor", { monitorName: "zudocs-services", monitorType: "DIMENSIONAL", monitorDimension: "SERVICE" });
      new ce.CfnAnomalySubscription(this, "AnomalyAlerts", {
        subscriptionName: "zudocs-anomalies",
        frequency: "DAILY",
        monitorArnList: [monitor.attrMonitorArn],
        subscribers: [{ type: "EMAIL", address: config.budget.email }],
        thresholdExpression: JSON.stringify({ Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["5"] } }),
      });
    }
    this.trailBucket = new s3.Bucket(this, "TrailBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The trail's objects expire; the monthly cost documents under `cost/` do not.
      lifecycleRules: [{ id: "trail-90d", prefix: TRAIL_PREFIX, expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new cloudtrail.Trail(this, "Trail", { trailName: "zudocs-management", bucket: this.trailBucket, isMultiRegionTrail: true, includeGlobalServiceEvents: true, enableFileValidation: true, sendToCloudWatchLogs: false });

    // --- The monthly cost check (phase 8) -------------------------------------------------------
    this.costCheck = new lambda.Function(this, "CostCheck", {
      functionName: COST_CHECK_FUNCTION_NAME,
      description: "Zudocs: the monthly cost check — Cost Explorer by service and by day, the budget, the expected month; files cost/YYYY-MM.json and puts Zudocs/Cost metrics",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(props.assets.costCheck),
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "CostCheckLogs", { logGroupName: `/aws/lambda/${COST_CHECK_FUNCTION_NAME}`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: { COST_BUCKET: this.trailBucket.bucketName, COST_PREFIX, BUDGET_NAME, ACCOUNT_ID: this.account },
    });
    // Cost Explorer has no resource-level scope; the budget, the prefix and the metric namespace do.
    this.costCheck.addToRolePolicy(new iam.PolicyStatement({ sid: "CostExplorerRead", actions: ["ce:GetCostAndUsage"], resources: ["*"] }));
    this.costCheck.addToRolePolicy(new iam.PolicyStatement({ sid: "BudgetRead", actions: ["budgets:ViewBudget"], resources: [`arn:${this.partition}:budgets::${this.account}:budget/${BUDGET_NAME}`] }));
    this.costCheck.addToRolePolicy(new iam.PolicyStatement({ sid: "CostDocument", actions: ["s3:PutObject"], resources: [this.trailBucket.arnForObjects(`${COST_PREFIX}*`)] }));
    this.costCheck.addToRolePolicy(new iam.PolicyStatement({ sid: "CostMetric", actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: { StringEquals: { "cloudwatch:namespace": COST_METRIC_NAMESPACE } } }));
    const schedulerRole = new iam.Role(this, "CostCheckScheduleRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"), description: "Assumed by EventBridge Scheduler to invoke the monthly cost check" });
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [this.costCheck.functionArn] }));
    new scheduler.CfnSchedule(this, "CostCheckMonthly", {
      name: COST_CHECK_SCHEDULE_NAME,
      description: "Zudocs: the monthly cost check on the third of the month, once Cost Explorer has settled the previous month (its document and the Zudocs/Cost metrics)",
      scheduleExpression: COST_CHECK_CRON_UTC,
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: { arn: this.costCheck.functionArn, roleArn: schedulerRole.roleArn, input: JSON.stringify({}), retryPolicy: { maximumRetryAttempts: 2 } },
    });
    new cdk.CfnOutput(this, "TrailBucketName", { value: this.trailBucket.bucketName, description: "The trail's bucket (RETAIN): AWSLogs/ for the trail, cost/ for the monthly cost documents" });
    new cdk.CfnOutput(this, "CostCheckFunctionName", { value: this.costCheck.functionName });
  }
}
