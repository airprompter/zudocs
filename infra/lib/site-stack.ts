/**
 * The us-east-1 stack: the company's public face and its account hygiene.
 *
 * - The hosted zone for the domain (the registrar's nameservers are pointed at
 *   the `NameServers` output once, by hand, from the account that holds the
 *   registration), with the mail records that keep the root mailbox forwarding.
 * - The landing page: a private S3 bucket behind CloudFront with an origin
 *   access control, the certificate for the apex, `www.` and `desk.`.
 * - Sign-in for the desk: a Cognito user pool with no self-signup, no account
 *   recovery, a public PKCE client scoped to `openid email` — users are created
 *   by hand (`admin-create-user`) for the owner today and sales people later.
 * - The monthly budget (e-mail alerts; the Bedrock deny action attaches to the
 *   runtime roles in phase 3), a management-events trail, and a cost anomaly
 *   monitor. The IAM policy the budget action will attach exists from day one.
 *
 * @example
 * ```ts
 * new SiteStack(app, "ZudocsSite", { config, env: { account: config.account, region: config.regions.site } });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_budgets as budgets, aws_ce as ce, aws_certificatemanager as acm, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_cloudtrail as cloudtrail, aws_cognito as cognito, aws_iam as iam, aws_route53 as route53, aws_route53_targets as targets, aws_s3 as s3, aws_s3_deployment as deploy } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ZudocsConfig } from "./config.js";

export interface SiteStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
}

export class SiteStack extends cdk.Stack {
  readonly zone: route53.PublicHostedZone;
  readonly certificate: acm.Certificate;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  /** Attached to every runtime role by the budget action when spend crosses the monthly line. */
  readonly bedrockDenyPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { domain } = config;

    // --- DNS ------------------------------------------------------------------------------------
    this.zone = new route53.PublicHostedZone(this, "Zone", { zoneName: domain, comment: "Zudocs (a fictional company built to demonstrate AirPrompter)" });
    // The root mailbox: SES inbound in the organisation's management account forwards every
    // address at the domain to the owner. The MX and DKIM records travel with the zone.
    new route53.MxRecord(this, "Mx", { zone: this.zone, values: [{ priority: 10, hostName: `inbound-smtp.${config.mail.inboundRegion}.amazonaws.com` }], ttl: cdk.Duration.minutes(5) });
    config.mail.dkimTokens.forEach((token, i) => {
      new route53.CnameRecord(this, `Dkim${i + 1}`, { zone: this.zone, recordName: `${token}._domainkey`, domainName: `${token}.dkim.amazonses.com`, ttl: cdk.Duration.minutes(5) });
    });
    new cdk.CfnOutput(this, "NameServers", { value: cdk.Fn.join(" ", this.zone.hostedZoneNameServers ?? []), description: "Point the registrar at these once" });

    // --- Certificate (CloudFront needs it in us-east-1) --------------------------------------
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: domain,
      subjectAlternativeNames: [`www.${domain}`, `desk.${domain}`],
      validation: acm.CertificateValidation.fromDns(this.zone),
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
        contentSecurityPolicy: { contentSecurityPolicy: "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'", override: true },
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
      errorResponses: [{ httpStatus: 404, responsePagePath: "/404.html", responseHttpStatus: 404, ttl: cdk.Duration.minutes(5) }],
      comment: `${domain} landing page`,
    });
    new deploy.BucketDeployment(this, "LandingFiles", {
      sources: [deploy.Source.asset(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "apps", "landing"))],
      destinationBucket: site,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });
    for (const [name, recordName] of [["Apex", undefined], ["Www", "www"]] as const) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, `${name}A`, { zone: this.zone, ...(recordName ? { recordName } : {}), target });
      new route53.AaaaRecord(this, `${name}Aaaa`, { zone: this.zone, ...(recordName ? { recordName } : {}), target });
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
    const hosted = this.userPool.addDomain("HostedUi", { cognitoDomain: { domainPrefix: `zudocs-${cdk.Names.uniqueResourceName(this, { maxLength: 8 }).toLowerCase()}` } });
    this.userPoolClient = this.userPool.addClient("Desk", {
      userPoolClientName: "desk",
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://desk.${domain}/callback`, "http://localhost:5173/callback"],
        logoutUrls: [`https://desk.${domain}/`, "http://localhost:5173/"],
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.hours(24),
    });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "HostedUiBase", { value: hosted.baseUrl() });

    // --- Money and audit ----------------------------------------------------------------------
    this.bedrockDenyPolicy = new iam.ManagedPolicy(this, "BedrockDeny", {
      managedPolicyName: "ZudocsBudgetBedrockDeny",
      description: "Attached by the budget action when the month's spend crosses the line: no more model calls",
      statements: [new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"], resources: ["*"] })],
    });
    const subscribers = config.budget.email ? [{ subscriptionType: "EMAIL", address: config.budget.email }] : [];
    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: "zudocs-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.budget.monthlyUsd, unit: "USD" },
      },
      notificationsWithSubscribers: subscribers.length
        ? [
            { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
            { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: (config.budget.alertUsd / config.budget.monthlyUsd) * 100, thresholdType: "PERCENTAGE" }, subscribers },
            { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
          ]
        : [],
    });
    if (config.budget.email) {
      const monitor = new ce.CfnAnomalyMonitor(this, "AnomalyMonitor", { monitorName: "zudocs-services", monitorType: "DIMENSIONAL", monitorDimension: "SERVICE" });
      new ce.CfnAnomalySubscription(this, "AnomalyAlerts", {
        subscriptionName: "zudocs-anomalies",
        frequency: "DAILY",
        monitorArnList: [monitor.attrMonitorArn],
        subscribers: [{ type: "EMAIL", address: config.budget.email }],
        thresholdExpression: JSON.stringify({ Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["5"] } }),
      });
    }
    const trailBucket = new s3.Bucket(this, "TrailBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new cloudtrail.Trail(this, "Trail", { trailName: "zudocs-management", bucket: trailBucket, isMultiRegionTrail: true, includeGlobalServiceEvents: true, enableFileValidation: true, sendToCloudWatchLogs: false });
  }
}
