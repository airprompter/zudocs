/**
 * The ap-southeast-1 fleet stack: the fleet pattern's always-on half. One puller holds the Agent key for the region
 * and every runtime behind it holds none.
 *
 * - The **exchange bucket** (`zudocs-exchange-<account>`: versioned, private, SSE-S3, TLS only; noncurrent versions
 *   and telemetry exports expire after thirty days): the puller writes each generation as a sealed `.apbundle` under
 *   `releases/` and a `latest.json` pointer; the air-gapped host writes the public half of its distribution key, its
 *   status document and its telemetry exports; the eu-west host reads the exports. `fleet-names.ts` is the layout.
 * - The **releases table** (`zudocs-agent-releases`, on demand): one row per generation pulled — digest, when, which
 *   key it is sealed to, where the object is — and the puller's own state row (the edge pointer's ETags, the backoff,
 *   what it mirrored last), written in the same transaction as the release row so a saved ETag never outruns a row.
 * - The **nudge queue** (`zudocs-nudge`, with a dead-letter queue after three failed receipts): the placeholder for
 *   the SDK's change-notification proposal. The desk's presenter posts one message; the puller consumes it and
 *   pulls with `skipPointer` — the origin is read once, conditionally. Pull-and-verify stays the only source of truth.
 * - The **puller** (Node 22, arm64, one at a time): every `PULL_MINUTES` (one minute with `--context demo=true`) the
 *   pointer-first `pullBundle` against AirPrompter with the Agent key read from the region's SSM SecureString at cold
 *   start, sealed to the air-gapped host's public key when the bucket holds one (plaintext otherwise — allowed on the
 *   dev target only, and the SDK refuses it anywhere else); the desk's status and events tables written across
 *   regions by ARN (its own row, and the air-gapped host's status document mirrored into a second row, since a host
 *   with no route out cannot reach a table in us-east-1).
 *
 * One thing a synth cannot catch: the region's SSM parameter must exist before the first tick
 * (`AWS_REGION=ap-southeast-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh`); until it does
 * every tick logs `agent_key_unreadable` and writes a failing status row that names the parameter.
 *
 * @example
 * ```ts
 * new FleetStack(app, "ZudocsFleet", { config, env: { account, region: config.regions.fleet }, assets: { puller: "…/services/puller/dist" }, airprompter: ids });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_dynamodb as dynamodb, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_lambda as lambda, aws_lambda_event_sources as sources, aws_logs as logs, aws_s3 as s3, aws_sqs as sqs } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { existsSync } from "node:fs";
import type { ZudocsConfig } from "./config.js";
import { tableNameOf, type AirPrompterIds } from "./desk-stack.js";
import { AIRGAP_HOST_ID, EXCHANGE, NUDGE_DLQ_NAME, NUDGE_QUEUE_NAME, PULL_MINUTES, PULL_MINUTES_DEMO, PULLER_FUNCTION_NAME, PULLER_HOST_ID, RELEASES_TABLE_NAME, exchangeBucketName } from "./fleet-names.js";

export interface FleetStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
  /** The bundled puller (`services/puller/dist`). */
  readonly assets: { readonly puller: string };
  readonly airprompter: AirPrompterIds;
}

/** The puller's tick in minutes from context: `demo=true` → one minute, else the plan's five. */
export function pullMinutesOf(demo: unknown): number {
  return String(demo) === "true" ? PULL_MINUTES_DEMO : PULL_MINUTES;
}

export class FleetStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  readonly table: dynamodb.Table;
  readonly queue: sqs.Queue;
  readonly puller: lambda.Function;

  constructor(scope: Construct, id: string, props: FleetStackProps) {
    super(scope, id, props);
    const { config, airprompter } = props;
    for (const [name, path] of Object.entries(props.assets)) if (!existsSync(path)) throw new Error(`fleet stack: the ${name} artefact is missing at ${path} — run \`npm run build\` first`);
    const tablesRegion = config.regions.site;
    const pullMinutes = pullMinutesOf(this.node.tryGetContext("demo"));

    // --- The exchange bucket -----------------------------------------------------------------------------------------
    this.bucket = new s3.Bucket(this, "Exchange", {
      bucketName: exchangeBucketName(this.account),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // The artefacts outlive the air-gapped host by design (`airgap:down` keeps them); the bucket outlives a stack delete.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: "noncurrent-30d", noncurrentVersionExpiration: cdk.Duration.days(30) },
        { id: "telemetry-30d", prefix: EXCHANGE.telemetryPrefix, expiration: cdk.Duration.days(30) },
        { id: "abort-multipart", abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
    });

    // --- The releases table --------------------------------------------------------------------------------------------
    this.table = new dynamodb.Table(this, "Releases", {
      tableName: RELEASES_TABLE_NAME,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "generation", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- The nudge queue and its dead letters ----------------------------------------------------------------------------
    const timeout = cdk.Duration.seconds(90);
    const dlq = new sqs.Queue(this, "NudgeDlq", { queueName: NUDGE_DLQ_NAME, encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: cdk.Duration.days(7) });
    this.queue = new sqs.Queue(this, "Nudge", {
      queueName: NUDGE_QUEUE_NAME,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // A nudge older than an hour is stale by then (the schedule has pulled); the visibility timeout is six times the function's.
      retentionPeriod: cdk.Duration.hours(1),
      visibilityTimeout: cdk.Duration.seconds(timeout.toSeconds() * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // --- The puller ------------------------------------------------------------------------------------------------------
    const parameterName = `/zudocs/${airprompter.environment}/agent-key`;
    const parameterArn = this.formatArn({ service: "ssm", resource: "parameter", resourceName: parameterName.slice(1) });
    const logGroup = new logs.LogGroup(this, "PullerLogs", { logGroupName: `/aws/lambda/${PULLER_FUNCTION_NAME}`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    this.puller = new lambda.Function(this, "Puller", {
      functionName: PULLER_FUNCTION_NAME,
      description: "Zudocs: the fleet's puller — pointer-first pullBundle into the releases table and the exchange bucket; consumes nudges; mirrors the air-gapped host's status",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(props.assets.puller),
      memorySize: 512,
      timeout,
      // One puller at a time: the schedule and the queue never race on the table's state row.
      reservedConcurrentExecutions: 1,
      logGroup,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        EXCHANGE_BUCKET: this.bucket.bucketName,
        RELEASES_TABLE: this.table.tableName,
        STATUS_TABLE: tableNameOf("status"),
        EVENTS_TABLE: tableNameOf("events"),
        TABLES_REGION: tablesRegion,
        AGENT_KEY_PARAMETER: parameterName,
        AIRPROMPTER_BASE_URL: airprompter.baseUrl,
        AIRPROMPTER_ORGANIZATION_ID: airprompter.organizationId,
        AIRPROMPTER_AGENT_ID: airprompter.agentId,
        AIRPROMPTER_ENVIRONMENT: airprompter.environment,
        AIRPROMPTER_HOSTED_ENVIRONMENT: airprompter.hostedEnvironment,
        AIRPROMPTER_ROOT_URL: airprompter.rootUrl,
        ...(airprompter.edgePointerUrl ? { AIRPROMPTER_EDGE_POINTER_URL: airprompter.edgePointerUrl } : {}),
        AIRPROMPTER_ROOT_JWK: airprompter.rootJwk,
        HOST_ID: PULLER_HOST_ID,
        AIRGAP_HOST_ID,
        PULL_INTERVAL_SECONDS: String(pullMinutes * 60),
      },
    });
    // The Agent key: one parameter by name, in this region, decrypted by SSM with the AWS-managed key.
    this.puller.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }));
    // The exchange: the puller writes releases and the pointer, and reads exactly the two objects the host writes for it.
    this.puller.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [this.bucket.arnForObjects(`${EXCHANGE.releasesPrefix}*`), this.bucket.arnForObjects(EXCHANGE.latest)] }));
    this.puller.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [this.bucket.arnForObjects(EXCHANGE.publicKey), this.bucket.arnForObjects(EXCHANGE.status)] }));
    this.puller.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"], resources: [this.table.tableArn] }));
    // The desk's status and events tables, across regions by ARN (`desk-stack.ts` fixes the names).
    const deskTable = (name: "status" | "events"): string => `arn:${this.partition}:dynamodb:${tablesRegion}:${this.account}:table/${tableNameOf(name)}`;
    this.puller.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [deskTable("status"), deskTable("events")] }));
    new events.Rule(this, "PullTick", {
      description: `Zudocs: the puller's schedule (every ${pullMinutes} minute${pullMinutes === 1 ? "" : "s"}; a pointer read when nothing moved)`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(pullMinutes)),
      targets: [new targets.LambdaFunction(this.puller, { event: events.RuleTargetInput.fromObject({ action: "tick" }) })],
    });
    // A nudge is one message, one pull; a message the puller fails three times lands in the dead-letter queue.
    this.puller.addEventSource(new sources.SqsEventSource(this.queue, { batchSize: 1, maxConcurrency: 2 }));

    new cdk.CfnOutput(this, "ExchangeBucketName", { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, "ReleasesTableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "NudgeQueueUrl", { value: this.queue.queueUrl });
    new cdk.CfnOutput(this, "NudgeDlqUrl", { value: dlq.queueUrl });
    new cdk.CfnOutput(this, "PullerFunctionName", { value: this.puller.functionName });
    new cdk.CfnOutput(this, "PullerHostId", { value: PULLER_HOST_ID, description: "The puller's row in the status table" });
    new cdk.CfnOutput(this, "AirgapHostId", { value: AIRGAP_HOST_ID, description: "The air-gapped host's row in the status table (mirrored by the puller from status/airgap.json)" });
    new cdk.CfnOutput(this, "PullMinutes", { value: String(pullMinutes) });
    new cdk.CfnOutput(this, "AgentKeyParameterName", { value: parameterName, description: `Write the Agent key here in ${this.region} as a SecureString (AWS_REGION=${this.region} ZUDOCS_SSM_KEY_ID=alias/aws/ssm scripts/ssm-put-agent-key.sh)` });
  }
}
