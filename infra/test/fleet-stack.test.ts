/**
 * The fleet stack pins: the exchange bucket (fixed name, versioned, private, TLS only, retained), the nudge queue
 * with its dead-letter queue and the puller consuming it one message at a time, the puller (Node 22 arm64, a
 * five-minute tick — one minute in demo context) with an environment that names the SSM parameter and never a key,
 * and an IAM policy that reaches one parameter by ARN, the datastore and the schedule in the bucket, the host's
 * public key and status, and the desk's two tables across regions — and nothing else.
 *
 * @example
 * ```sh
 * npx tsx --test test/fleet-stack.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Match } from "aws-cdk-lib/assertions";
import { STACK_IDS } from "../lib/app.js";
import { EXCHANGE, NUDGE_DLQ_NAME, NUDGE_QUEUE_NAME, PULLER_FUNCTION_NAME, exchangeBucketName } from "../lib/fleet-names.js";
import { pullMinutesOf } from "../lib/fleet-stack.js";
import { actionsOf, statementsOf, synthAll, type Resources } from "./fixtures.js";

test("the stack is in ap-southeast-1; the exchange bucket is fixed-name, versioned, private, TLS-only and retained; the telemetry prefix and old versions expire", () => {
  const { fleet, stacks } = synthAll();
  assert.equal(STACK_IDS.fleet, "ZudocsFleet");
  assert.equal(stacks.fleet.region, "ap-southeast-1");
  fleet.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  fleet.hasResourceProperties("AWS::S3::Bucket", {
    BucketName: exchangeBucketName("111122223333"),
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Id: "noncurrent-30d" }), Match.objectLike({ Prefix: EXCHANGE.telemetryPrefix, ExpirationInDays: 30 })]) },
  });
  const [bucket] = Object.values(fleet.findResources("AWS::S3::Bucket") as Resources);
  const noncurrent = (bucket!.Properties.LifecycleConfiguration.Rules as Array<Record<string, unknown>>).find((r) => r.Id === "noncurrent-30d")!;
  assert.ok(JSON.stringify(noncurrent).includes("30"), "old versions expire after thirty days");
  const [policy] = Object.values(fleet.findResources("AWS::S3::BucketPolicy") as Resources);
  assert.ok(JSON.stringify(policy!.Properties.PolicyDocument).includes('"aws:SecureTransport":"false"'), "TLS only");
});

test("the nudge queue has a dead-letter queue after three receipts, TLS only, a one-hour retention", () => {
  const { fleet } = synthAll();
  assert.equal(Object.keys(fleet.findResources("AWS::DynamoDB::Table")).length, 0, "the release lives in the exchange bucket, not a table");
  fleet.hasResourceProperties("AWS::SQS::Queue", { QueueName: NUDGE_QUEUE_NAME, MessageRetentionPeriod: 3600, VisibilityTimeout: 540, RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }) });
  fleet.hasResourceProperties("AWS::SQS::Queue", { QueueName: NUDGE_DLQ_NAME });
  const policies = Object.values(fleet.findResources("AWS::SQS::QueuePolicy") as Resources);
  assert.equal(policies.length, 2, "both queues refuse plain HTTP");
  fleet.hasResourceProperties("AWS::Lambda::EventSourceMapping", { BatchSize: 1, ScalingConfig: { MaximumConcurrency: 2 } });
});

test("the puller: Node 22 arm64, a 90 s timeout, a five-minute tick (one minute with demo=true); its environment names the parameter and the pinned root, never a key", () => {
  const { fleet } = synthAll();
  const [fn] = Object.values(fleet.findResources("AWS::Lambda::Function", { Properties: { FunctionName: PULLER_FUNCTION_NAME } }) as Resources);
  assert.ok(fn, "the puller function");
  assert.equal(fn!.Properties.Runtime, "nodejs22.x");
  assert.deepEqual(fn!.Properties.Architectures, ["arm64"]);
  assert.equal(fn!.Properties.ReservedConcurrentExecutions, undefined, "no reserved concurrency of one (it would throttle the SQS poller); the state object's ETag settles a race");
  assert.equal((fn!.Properties.Environment.Variables as Record<string, unknown>).RELEASES_TABLE, undefined);
  assert.equal(fn!.Properties.Timeout, 90);
  const env = fn!.Properties.Environment.Variables as Record<string, unknown>;
  assert.equal(env.AGENT_KEY_PARAMETER, "/zudocs/dev/agent-key");
  assert.equal(env.PULL_INTERVAL_SECONDS, "300");
  assert.equal(env.HOST_ID, "ap-southeast-1/puller");
  assert.equal(env.AIRGAP_HOST_ID, "ap-southeast-1/airgap");
  assert.equal(env.STATUS_TABLE, "zudocs-desk-status");
  assert.equal(env.TABLES_REGION, "us-east-1");
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!/^AIRPROMPTER_AGENT_KEY$|_SECRET$|TOKEN$|PASSWORD$/.test(name), `${name} is not a value-shaped variable`);
    assert.ok(!/^apa_/.test(String(value)), `${name} holds no key`);
  }
  fleet.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)", Targets: [Match.objectLike({ Input: JSON.stringify({ action: "tick" }) })] });
  assert.equal(pullMinutesOf("true"), 1);
  assert.equal(pullMinutesOf(undefined), 5);
  const demo = synthAll("owner@example.test", { demo: "true" });
  demo.fleet.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 minute)" });
  assert.equal((Object.values(demo.fleet.findResources("AWS::Lambda::Function", { Properties: { FunctionName: PULLER_FUNCTION_NAME } }) as Resources)[0]!.Properties.Environment.Variables as Record<string, string>).PULL_INTERVAL_SECONDS, "60");
});

test("the puller's policy: one parameter by ARN in its region; the datastore and the schedule in the bucket; the host's public key and status; the desk's tables across regions; the queue", () => {
  const { fleet } = synthAll();
  const statements = statementsOf(fleet);
  const parameter = statements.filter((st) => actionsOf(st).includes("ssm:GetParameter"));
  assert.equal(parameter.length, 1);
  assert.deepEqual(actionsOf(parameter[0]!), ["ssm:GetParameter"]);
  assert.ok(JSON.stringify(parameter[0]!.Resource).includes(":ssm:ap-southeast-1:111122223333:parameter/zudocs/dev/agent-key"), "one parameter, in this region, by ARN");
  const s3Write = statements.find((st) => actionsOf(st).includes("s3:PutObject"))!;
  assert.deepEqual(actionsOf(s3Write).sort(), ["s3:GetObject", "s3:PutObject"]);
  const writeResources = JSON.stringify(s3Write.Resource);
  assert.ok(writeResources.includes(`/${EXCHANGE.datastorePrefix}*`) && writeResources.includes(`/${EXCHANGE.pullerState}`), "reads and writes the datastore and the schedule");
  assert.ok(!writeResources.includes("/keys/") && !writeResources.includes("/status/") && !writeResources.includes("/telemetry/"), "never the host's keys, status or exports");
  const s3Get = statements.find((st) => actionsOf(st).includes("s3:GetObject") && !actionsOf(st).includes("s3:PutObject"))!;
  assert.deepEqual(actionsOf(s3Get), ["s3:GetObject"]);
  const getResources = JSON.stringify(s3Get.Resource);
  assert.ok(getResources.includes(`/${EXCHANGE.publicKey}`) && getResources.includes(`/${EXCHANGE.status}`), "reads the public key and the status document");
  assert.ok(!getResources.includes("/telemetry/"), "reads nothing else of the host's");
  const list = statements.find((st) => actionsOf(st).includes("s3:ListBucket"))!;
  assert.deepEqual(list.Condition, { StringLike: { "s3:prefix": [`${EXCHANGE.datastorePrefix}*`, "puller/*", EXCHANGE.publicKey, EXCHANGE.status] } });
  const dynamo = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("dynamodb:")));
  assert.equal(dynamo.length, 1, "the desk's tables only");
  const desk = dynamo[0]!;
  assert.deepEqual(actionsOf(desk).sort(), ["dynamodb:PutItem", "dynamodb:UpdateItem"], "the puller never reads the desk's tables");
  assert.deepEqual([...(desk.Resource as string[])].sort(), ["arn:aws:dynamodb:us-east-1:111122223333:table/zudocs-desk-events", "arn:aws:dynamodb:us-east-1:111122223333:table/zudocs-desk-status"]);
  assert.ok(statements.some((st) => actionsOf(st).includes("sqs:ReceiveMessage") && actionsOf(st).includes("sqs:DeleteMessage")), "consumes the queue");
  assert.ok(!statements.some((st) => actionsOf(st).some((a) => a.startsWith("bedrock:") || a === "*")), "no model, no wildcard");
  assert.ok(!statements.some((st) => JSON.stringify(st.Resource) === '"*"' && actionsOf(st).some((a) => a.startsWith("s3:") || a.startsWith("dynamodb:"))), "no wildcard resource on data");
});

test("the outputs the proof and the desk read", () => {
  const { fleet } = synthAll();
  const outputs = fleet.toJSON().Outputs as Record<string, { Value: unknown }>;
  for (const key of ["ExchangeBucketName", "DatastorePrefix", "NudgeQueueUrl", "NudgeDlqUrl", "PullerFunctionName", "PullerHostId", "AirgapHostId", "PullMinutes", "AgentKeyParameterName"]) assert.ok(outputs[key], key);
  assert.equal(outputs.DatastorePrefix!.Value, EXCHANGE.datastorePrefix);
  assert.equal(outputs.PullerHostId!.Value, "ap-southeast-1/puller");
});
