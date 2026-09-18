/**
 * The us-east-1 desk stack: the serverless host and the app a prospect watches.
 *
 * - Seven on-demand DynamoDB tables (tickets, customers, runs, feedback, status, events, counters) — the desk's
 *   own data plane; a KMS key that wraps the SDK's slot-store data key and encrypts the SSM SecureString the
 *   Agent key lives in. The stack knows that parameter by NAME only; the owner writes the value by hand
 *   (`--cli-input-json file://…`, never argv) and the Lambda reads it at cold start.
 * - The desk API: one Node 22 arm64 function (reserved concurrency 5, logs kept seven days) behind an HTTP API
 *   whose every route carries the Cognito JWT authorizer (the desk's PKCE client and the proof client as
 *   audiences) and whose stage throttles. Its IAM reaches exactly the three models the catalogue names, the
 *   tables, the key, the parameter and itself (the replay job).
 * - The desk SPA on a private bucket behind CloudFront at `desk.<domain>` with the site stack's certificate and a
 *   strict CSP that allows exactly the API and the hosted UI as connect targets; its runtime configuration is a
 *   `config.json` written at deploy time from the stack's own outputs.
 * - The Budgets action: at 100 % of `zudocs-monthly`, `ZudocsBudgetBedrockDeny` is attached to the function's role
 *   automatically — a bug that loops stops paying for models without a person awake.
 *
 * Two things a synth cannot catch: the SSM parameter must exist before the first request (the function fails its
 * cold start with the parameter's name otherwise), and Bedrock model access in a fresh account is a per-model
 * agreement plus an account verification AWS runs — until both are done, every run refuses visibly.
 *
 * @example
 * ```ts
 * new DeskStack(app, "ZudocsDesk", { config, site, zone: dns.zone, env, assets: { deskApi: "…/services/desk-api/dist", deskSite: "…/apps/desk/dist" } });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_apigatewayv2 as apigwv2, aws_apigatewayv2_authorizers as authorizers, aws_apigatewayv2_integrations as integrations, aws_budgets as budgets, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, aws_lambda as lambda, aws_logs as logs, aws_route53 as route53, aws_route53_targets as targets, aws_s3 as s3, aws_s3_deployment as deploy } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE } from "../../services/desk-api/src/modelCatalogue.js";
import { ROUTES } from "../../services/desk-api/src/router.js";
import type { ZudocsConfig } from "./config.js";
import { BUDGET_NAME, type SiteStack } from "./site-stack.js";

export interface DeskStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
  readonly site: SiteStack;
  readonly zone: route53.IHostedZone;
  /** Built artefacts: the bundled Lambda (`services/desk-api/dist`) and the built SPA (`apps/desk/dist`). */
  readonly assets: { readonly deskApi: string; readonly deskSite: string };
  /** The AirPrompter identifiers (`airprompter.config.json`) and the pinned root JWK text. */
  readonly airprompter: AirPrompterIds;
}

export interface AirPrompterIds {
  readonly baseUrl: string;
  readonly hostedEnvironment: string;
  readonly rootUrl: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly environment: string;
  readonly rootJwk: string;
}

export const DESK_FUNCTION_NAME = "zudocs-desk-api";
export const DESK_KEY_ALIAS = "alias/zudocs-desk";
/** Runs per UTC day before the API refuses with 429. */
export const DAILY_RUN_CAP = 2000;
export const EMF_NAMESPACE = "Zudocs/Desk";
export const TABLE_NAMES = ["tickets", "customers", "runs", "feedback", "status", "events", "counters"] as const;

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** The cap from context (a positive integer up to the plan's line), else the plan's line. */
export function dailyRunCapOf(context: unknown): number {
  if (context === undefined || context === null) return DAILY_RUN_CAP;
  const value = Number(context);
  if (!Number.isInteger(value) || value < 1 || value > DAILY_RUN_CAP) throw new Error(`dailyRunCap must be an integer from 1 to ${DAILY_RUN_CAP} (got ${String(context)})`);
  return value;
}

/** The identifiers and the pinned root from the repository, for the entry point (never a key). */
export function readAirPrompterIds(root = repoRoot): AirPrompterIds {
  const file = JSON.parse(readFileSync(join(root, "airprompter.config.json"), "utf8")) as Record<string, string>;
  const need = (key: string): string => {
    const value = file[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`airprompter.config.json: ${key} is missing`);
    return value.trim();
  };
  const hosted = need("hostedEnvironment");
  const rootPath = join(root, "keys", `${hosted}.root.jwk.json`);
  if (!existsSync(rootPath)) throw new Error(`${rootPath} is missing: the pinned root for the ${hosted} deployment`);
  const jwk = JSON.parse(readFileSync(rootPath, "utf8")) as Record<string, unknown>;
  if (jwk.d !== undefined) throw new Error(`${rootPath} carries a private member; keys/ holds public JWKs only`);
  return { baseUrl: need("baseUrl"), hostedEnvironment: hosted, rootUrl: need("rootUrl"), organizationId: need("organizationId"), agentId: need("agentId"), environment: need("environment"), rootJwk: JSON.stringify(jwk) };
}

export class DeskStack extends cdk.Stack {
  readonly api: apigwv2.HttpApi;
  readonly fn: lambda.Function;
  readonly key: kms.Key;
  readonly tables: Record<(typeof TABLE_NAMES)[number], dynamodb.Table>;

  constructor(scope: Construct, id: string, props: DeskStackProps) {
    super(scope, id, props);
    const { config, site, zone, assets, airprompter } = props;
    const { domain } = config;
    const deskDomain = `desk.${domain}`;
    for (const [name, path] of Object.entries(assets)) if (!existsSync(path)) throw new Error(`desk stack: the ${name} artefact is missing at ${path} — run \`npm run build\` first`);

    // --- Data plane ---------------------------------------------------------------------------
    const table = (name: (typeof TABLE_NAMES)[number], key: dynamodb.Attribute, sortKey?: dynamodb.Attribute): dynamodb.Table =>
      new dynamodb.Table(this, `${name[0]!.toUpperCase()}${name.slice(1)}Table`, {
        tableName: `zudocs-desk-${name}`,
        partitionKey: key,
        ...(sortKey ? { sortKey } : {}),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        ...(name === "events" ? { timeToLiveAttribute: "expiresAt" } : {}),
      });
    const S = dynamodb.AttributeType.STRING;
    this.tables = {
      tickets: table("tickets", { name: "ticketId", type: S }),
      customers: table("customers", { name: "customerId", type: S }),
      runs: table("runs", { name: "runId", type: S }),
      feedback: table("feedback", { name: "runId", type: S }, { name: "at", type: S }),
      status: table("status", { name: "hostId", type: S }),
      events: table("events", { name: "day", type: S }, { name: "sk", type: S }),
      counters: table("counters", { name: "pk", type: S }),
    };
    this.tables.runs.addGlobalSecondaryIndex({ indexName: "byTicket", partitionKey: { name: "ticketId", type: S }, sortKey: { name: "at", type: S }, projectionType: dynamodb.ProjectionType.ALL });

    // --- The key and the parameter's name -----------------------------------------------------
    this.key = new kms.Key(this, "Key", {
      alias: DESK_KEY_ALIAS,
      description: "Zudocs desk: wraps the SDK slot store's data key (customKeyProvider) and encrypts the Agent key parameter",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const agentKeyParameter = `/zudocs/${airprompter.environment}/agent-key`;
    const parameterArn = this.formatArn({ service: "ssm", resource: "parameter", resourceName: agentKeyParameter.slice(1) });

    // --- The function ---------------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, "ApiLogs", { logGroupName: `/aws/lambda/${DESK_FUNCTION_NAME}`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    this.fn = new lambda.Function(this, "Api", {
      functionName: DESK_FUNCTION_NAME,
      description: "Zudocs desk API: the AirPrompter Agent SDK in on_invoke mode; runs tickets through the promoted prompts on Bedrock",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(assets.deskApi),
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      logGroup,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        TICKETS_TABLE: this.tables.tickets.tableName,
        CUSTOMERS_TABLE: this.tables.customers.tableName,
        RUNS_TABLE: this.tables.runs.tableName,
        FEEDBACK_TABLE: this.tables.feedback.tableName,
        STATUS_TABLE: this.tables.status.tableName,
        EVENTS_TABLE: this.tables.events.tableName,
        COUNTERS_TABLE: this.tables.counters.tableName,
        KMS_KEY_ID: this.key.keyArn,
        AGENT_KEY_PARAMETER: agentKeyParameter,
        AIRPROMPTER_BASE_URL: airprompter.baseUrl,
        AIRPROMPTER_ORGANIZATION_ID: airprompter.organizationId,
        AIRPROMPTER_AGENT_ID: airprompter.agentId,
        AIRPROMPTER_ENVIRONMENT: airprompter.environment,
        AIRPROMPTER_HOSTED_ENVIRONMENT: airprompter.hostedEnvironment,
        AIRPROMPTER_ROOT_URL: airprompter.rootUrl,
        AIRPROMPTER_ROOT_JWK: airprompter.rootJwk,
        // `--context dailyRunCap=2` for the cap proof; the default is the plan's line.
        DAILY_RUN_CAP: String(dailyRunCapOf(this.node.tryGetContext("dailyRunCap"))),
        STATE_EPOCH: (this.node.tryGetContext("stateEpoch") as string | undefined) ?? "1",
        HOST_ID: "us-east-1/lambda",
        EMF_NAMESPACE,
        HEARTBEAT_SECONDS: "60",
      },
    });
    for (const t of Object.values(this.tables)) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem"], resources: [t.tableArn, `${t.tableArn}/index/*`] }));
    }
    // The store's data key: wrap and unwrap under this application's own encryption context, nothing else.
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["kms:Encrypt", "kms:Decrypt"], resources: [this.key.keyArn], conditions: { StringEquals: { "kms:EncryptionContext:application": "zudocs-desk" } } }));
    // The Agent key: one parameter by name, decrypted by SSM on this function's behalf with this key.
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["kms:Decrypt"], resources: [this.key.keyArn], conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com`, "kms:EncryptionContext:PARAMETER_ARN": parameterArn } } }));
    // Bedrock: exactly the catalogue's models — the foundation models in any region a cross-region profile fans out to, and our profiles here.
    const foundationModels = [...new Set(Object.values(CATALOGUE).map((m) => m.foundationModelId))].map((id) => `arn:${this.partition}:bedrock:*::foundation-model/${id}`);
    const profiles = Object.values(CATALOGUE).filter((m) => m.bedrockId !== m.foundationModelId).map((m) => this.formatArn({ service: "bedrock", resource: "inference-profile", resourceName: m.bedrockId }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"], resources: [...foundationModels, ...profiles] }));
    // The OpenAI-compatible bedrock-mantle endpoint authorises its own action on the account's default project
    // (found by the first real call: "not authorized to perform: bedrock-mantle:CreateInference"); the model is
    // still the catalogue's — the endpoint checks the model agreement, not a per-model ARN.
    if (Object.values(CATALOGUE).some((m) => m.path === "mantle")) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock-mantle:CreateInference"], resources: [this.formatArn({ service: "bedrock-mantle", resource: "project", resourceName: "default" })] }));
    }
    // The replay job: the function invokes itself asynchronously (by its fixed name, so the policy has no cycle).
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [this.formatArn({ service: "lambda", resource: "function", resourceName: DESK_FUNCTION_NAME, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })] }));

    // --- The API ----------------------------------------------------------------------------------
    const authorizer = new authorizers.HttpJwtAuthorizer("Jwt", site.userPool.userPoolProviderUrl, { jwtAudience: [site.userPoolClient.userPoolClientId, site.proofClient.userPoolClientId], identitySource: ["$request.header.Authorization"] });
    this.api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "zudocs-desk",
      description: "Zudocs desk API (Cognito JWT on every route)",
      defaultAuthorizer: authorizer,
      corsPreflight: { allowOrigins: [`https://${deskDomain}`, "http://localhost:5173"], allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST], allowHeaders: ["authorization", "content-type"], maxAge: cdk.Duration.hours(1) },
      createDefaultStage: true,
    });
    const integration = new integrations.HttpLambdaIntegration("ApiIntegration", this.fn);
    for (const route of ROUTES) this.api.addRoutes({ path: route.pattern, methods: [route.method === "GET" ? apigwv2.HttpMethod.GET : apigwv2.HttpMethod.POST], integration });
    const stage = this.api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 10, throttlingRateLimit: 5 };
    new cdk.CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });

    // --- The desk SPA -----------------------------------------------------------------------------
    const bucket = new s3.Bucket(this, "DeskBucket", { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, removalPolicy: cdk.RemovalPolicy.DESTROY, autoDeleteObjects: true });
    const hostedUi = `https://${site.hostedUiDomain.domainName}.auth.${this.region}.amazoncognito.com`;
    const headers = new cloudfront.ResponseHeadersPolicy(this, "DeskHeaders", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        // The app has no inline script or style; it talks to the API and to the hosted UI's token endpoint and nothing else.
        contentSecurityPolicy: { contentSecurityPolicy: `default-src 'self'; connect-src 'self' ${this.api.apiEndpoint} ${hostedUi}; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' ${hostedUi}; frame-ancestors 'none'`, override: true },
      },
    });
    const distribution = new cloudfront.Distribution(this, "Desk", {
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, responseHeadersPolicy: headers, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED },
      defaultRootObject: "index.html",
      domainNames: [deskDomain],
      certificate: site.certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // A single-page app: every path the bucket does not hold (S3 answers 403 to GetObject-only origins) is the app.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(1) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(1) },
      ],
      comment: `${deskDomain} (the Zudocs desk)`,
    });
    new deploy.BucketDeployment(this, "DeskFiles", {
      sources: [
        deploy.Source.asset(assets.deskSite),
        deploy.Source.jsonData("config.json", { apiUrl: this.api.apiEndpoint, region: this.region, userPoolId: site.userPool.userPoolId, clientId: site.userPoolClient.userPoolClientId, hostedUi, deskUrl: `https://${deskDomain}`, environment: airprompter.environment, agentId: airprompter.agentId }),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, "DeskA", { zone, recordName: "desk", target });
    new route53.AaaaRecord(this, "DeskAaaa", { zone, recordName: "desk", target });
    new cdk.CfnOutput(this, "DeskUrl", { value: `https://${deskDomain}` });
    new cdk.CfnOutput(this, "AgentKeyParameterName", { value: agentKeyParameter, description: "Write the Agent key here as a SecureString with --key-id alias/zudocs-desk (README)" });
    new cdk.CfnOutput(this, "KeyAlias", { value: DESK_KEY_ALIAS });

    // --- The Budgets action -------------------------------------------------------------------------
    if (config.budget.email) {
      const actionRole = new iam.Role(this, "BudgetActionRole", { assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com"), description: "Assumed by AWS Budgets to attach the Bedrock deny policy to the desk function's role" });
      actionRole.addToPolicy(new iam.PolicyStatement({ actions: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"], resources: [this.fn.role!.roleArn] }));
      new budgets.CfnBudgetsAction(this, "BedrockDenyAction", {
        budgetName: BUDGET_NAME,
        actionType: "APPLY_IAM_POLICY",
        actionThreshold: { type: "PERCENTAGE", value: 100 },
        notificationType: "ACTUAL",
        approvalModel: "AUTOMATIC",
        executionRoleArn: actionRole.roleArn,
        definition: { iamActionDefinition: { policyArn: site.bedrockDenyPolicy.managedPolicyArn, roles: [this.fn.role!.roleName] } },
        subscribers: [{ type: "EMAIL", address: config.budget.email }],
      });
    }
  }
}
