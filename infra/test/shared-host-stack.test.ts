/**
 * The eu-west stack pins: one t4g.micro on AL2023 arm64 in a public subnet of a VPC with no NAT and no endpoints,
 * IMDSv2 required, 8 GiB gp3 encrypted, no key pair; a security group with no inbound rule; an instance role of a
 * fixed name that reaches one SSM parameter, the bundle, the catalogue's models in the desk's region, the desk's
 * eight tables by ARN across regions and its own log group — and not AmazonSSMManagedInstanceCore; user data
 * rendered from the template with the pinned digest and never a key; the wire function on a five-minute tick with
 * write access to its own group only; the outputs the proof reads.
 *
 * @example
 * ```sh
 * npx tsx --test test/shared-host-stack.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Match } from "aws-cdk-lib/assertions";
import { CATALOGUE } from "../../services/desk-api/src/modelCatalogue.js";
import { STACK_IDS } from "../lib/app.js";
import { TABLE_NAMES } from "../lib/desk-stack.js";
import { EU_HOST_ROLE_NAME, WIRE_FUNCTION_NAME, readPins } from "../lib/shared-host-names.js";
import { USER_DATA_TEMPLATE, renderUserData } from "../lib/shared-host-stack.js";
import { PINS, actionsOf, statementsOf, synthAll, type Resources } from "./fixtures.js";

test("the stack is in eu-west-1 with the fixed ids; the network is one public subnet, no NAT, no endpoints; the group has no inbound rule and open egress", () => {
  const { sharedHost, stacks } = synthAll();
  assert.equal(STACK_IDS.sharedHost, "ZudocsSharedHost");
  assert.equal(stacks.sharedHost.region, "eu-west-1");
  assert.equal(Object.keys(sharedHost.findResources("AWS::EC2::NatGateway")).length, 0);
  assert.equal(Object.keys(sharedHost.findResources("AWS::EC2::VPCEndpoint")).length, 0);
  assert.equal(Object.keys(sharedHost.findResources("AWS::EC2::Subnet")).length, 1);
  assert.equal(Object.keys(sharedHost.findResources("AWS::EC2::InternetGateway")).length, 1);
  const groups = Object.values(sharedHost.findResources("AWS::EC2::SecurityGroup") as Resources);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.Properties.SecurityGroupIngress, undefined, "no inbound rule at all");
  assert.deepEqual(groups[0]!.Properties.SecurityGroupEgress, [{ CidrIp: "0.0.0.0/0", Description: "Allow all outbound traffic by default", IpProtocol: "-1" }]);
  assert.equal(Object.keys(sharedHost.findResources("AWS::EC2::KeyPair")).length, 0, "no key pair: Session Manager only");
});

test("the instance: t4g.micro, the pinned AL2023 arm64 image, IMDSv2 required, 8 GiB gp3 encrypted, a public address, the fixed role; user data replaces the instance when it changes", () => {
  const { sharedHost } = synthAll();
  sharedHost.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t4g.micro", Monitoring: false, BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 8, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }] });
  const [instance] = Object.values(sharedHost.findResources("AWS::EC2::Instance") as Resources);
  assert.equal(instance!.Properties.NetworkInterfaces?.[0]?.AssociatePublicIpAddress, true);
  sharedHost.hasResourceProperties("AWS::EC2::LaunchTemplate", { LaunchTemplateData: Match.objectLike({ MetadataOptions: { HttpTokens: "required" } }) });
  sharedHost.hasResourceProperties("AWS::IAM::Role", { RoleName: EU_HOST_ROLE_NAME });
  const [instanceId] = Object.keys(sharedHost.findResources("AWS::EC2::Instance"));
  const dependsOn = (sharedHost.toJSON().Resources as Record<string, { DependsOn?: string[] }>)[instanceId!]!.DependsOn ?? [];
  assert.ok(dependsOn.includes("PublicRoute") && dependsOn.includes("PublicRouteAssociation") && dependsOn.includes("IgwAttachment"), `the instance waits for its route to the internet (${dependsOn.join(", ")})`);
  assert.equal(instance!.Properties.ImageId, "ami-0535b4996339a5410", "the pinned image, not a deploy-time lookup");
  const userData = Buffer.from(JSON.stringify(instance!.Properties.UserData)).toString("utf8");
  assert.ok(userData.includes("f".repeat(64)), "the pinned CLI digest is in the script");
  assert.ok(userData.includes("releases/download/cli/v0.1.0/airprompter-linux-arm64"));
  assert.ok(!/__[A-Z0-9_]+__/.test(userData), "every placeholder rendered");
  assert.ok(!/AIRPROMPTER_AGENT_KEY=|apa_/.test(userData), "no key in user data");
  assert.ok(userData.includes("zudocs-agent-key"), "the key file is written from SSM by the helper");
  assert.ok(userData.includes("aws s3 cp"), "the bundle from the asset bucket");
});

test("the instance role: Session Manager by its own actions (not the managed policy that reads every parameter), one parameter, the bundle, the models in the desk's region, the eight tables by ARN, its log group", () => {
  const { sharedHost } = synthAll();
  const [role] = Object.values(sharedHost.findResources("AWS::IAM::Role", { Properties: { RoleName: EU_HOST_ROLE_NAME } }) as Resources);
  assert.equal(role!.Properties.ManagedPolicyArns, undefined, "no managed policy: AmazonSSMManagedInstanceCore would grant ssm:GetParameter on *");
  const statements = statementsOf(sharedHost);
  const session = statements.find((st) => st.Sid === "SessionManager")!;
  assert.ok(actionsOf(session).includes("ssmmessages:OpenDataChannel") && actionsOf(session).includes("ec2messages:GetMessages") && actionsOf(session).includes("ssm:UpdateInstanceInformation"));
  assert.ok(!actionsOf(session).some((a) => a.startsWith("ssm:GetParameter")), "the session statement reads no parameter");
  const parameter = statements.filter((st) => actionsOf(st).includes("ssm:GetParameter"));
  assert.equal(parameter.length, 1);
  assert.ok(JSON.stringify(parameter[0]!.Resource).includes(":ssm:eu-west-1:111122223333:parameter/zudocs/dev/agent-key"), "one parameter, in this region, by ARN");
  const dynamo = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("dynamodb:")) && actionsOf(st).length > 1);
  assert.equal(dynamo.length, 1, "the host's one table statement (the wire function's PutItem is the other)");
  assert.deepEqual(actionsOf(dynamo[0]!).sort(), ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem"], "no BatchWrite (no seed), no delete");
  const tables = JSON.stringify(dynamo[0]!.Resource);
  for (const name of TABLE_NAMES) assert.ok(tables.includes(`arn:aws:dynamodb:us-east-1:111122223333:table/zudocs-desk-${name}`), name);
  assert.ok(tables.includes("table/zudocs-desk-runs/index/*"), "the runs table's index for the ticket view");
  assert.ok(!tables.includes('"*"'));
  const bedrock = statements.find((st) => actionsOf(st).includes("bedrock:Converse"))!;
  const models = JSON.stringify(bedrock.Resource);
  for (const entry of Object.values(CATALOGUE)) assert.ok(models.includes(`foundation-model/${entry.foundationModelId}`), entry.foundationModelId);
  assert.ok(models.includes("arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.nova-2-lite-v1:0"), "the profiles in the desk's region, where the models are called");
  assert.ok(!models.includes("foundation-model/*"));
  const mantle = statements.find((st) => actionsOf(st).includes("bedrock-mantle:CreateInference"))!;
  assert.ok(JSON.stringify(mantle.Resource).includes("arn:aws:bedrock-mantle:us-east-1:111122223333:project/default"));
  const s3 = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("s3:")));
  assert.equal(s3.length, 4, "the asset bucket; the exchange bucket's telemetry/ prefix (read), imports/ prefix (the ledger, write) and a listing of those two prefixes");
  for (const st of s3) assert.ok(!actionsOf(st).some((a) => /Delete/.test(a)), "the host deletes nothing anywhere");
  const importsWrite = s3.find((st) => st.Sid === "ExchangeImportsWrite")!;
  assert.deepEqual(actionsOf(importsWrite), ["s3:PutObject"]);
  assert.deepEqual(importsWrite.Resource, "arn:aws:s3:::zudocs-exchange-111122223333/imports/*", "the ledger's markers only — never releases/, keys/, status/ or telemetry/");
  const telemetryRead = s3.find((st) => st.Sid === "ExchangeTelemetryRead")!;
  assert.deepEqual(actionsOf(telemetryRead), ["s3:GetObject"]);
  assert.deepEqual(telemetryRead.Resource, "arn:aws:s3:::zudocs-exchange-111122223333/telemetry/*", "the exports only — never releases/, keys/ or status/");
  const telemetryList = s3.find((st) => st.Sid === "ExchangeTelemetryList")!;
  assert.deepEqual(actionsOf(telemetryList), ["s3:ListBucket"]);
  assert.deepEqual(telemetryList.Condition, { StringLike: { "s3:prefix": ["telemetry/*", "imports/*"] } }, "a listing of the telemetry/ and imports/ prefixes only");
  const logsStatements = statements.filter((st) => actionsOf(st).includes("logs:PutLogEvents"));
  assert.equal(logsStatements.length, 1);
  assert.ok(JSON.stringify(logsStatements[0]!.Resource).includes("HostLogs"), "its own group");
  sharedHost.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/zudocs/eu-host", RetentionInDays: 7 });
  assert.ok(!statements.some((st) => actionsOf(st).some((a) => a.startsWith("kms:"))), "no KMS statement: the AWS-managed SSM key decrypts the parameter for SSM's callers");
});

test("the wire function: Node 22 arm64 by its fixed name, the group id and the limit in its environment, write access to its own group and the events table only, a five-minute tick", () => {
  const { sharedHost } = synthAll();
  sharedHost.hasResourceProperties("AWS::Lambda::Function", { FunctionName: WIRE_FUNCTION_NAME, Runtime: "nodejs22.x", Architectures: ["arm64"], Handler: "index.handler", Timeout: 30, Environment: { Variables: Match.objectLike({ HOST_ID: "eu-west-1/ec2", DYNAMODB_REGION: "us-east-1", EVENTS_TABLE: "zudocs-desk-events", WIRE_CUT_MAX_MINUTES: "15" }) } });
  const statements = statementsOf(sharedHost);
  const egress = statements.find((st) => actionsOf(st).includes("ec2:AuthorizeSecurityGroupEgress"))!;
  assert.deepEqual(actionsOf(egress).sort(), ["ec2:AuthorizeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags", "ec2:RevokeSecurityGroupEgress"]);
  assert.ok(JSON.stringify(egress.Resource).includes("security-group/") && !JSON.stringify(egress.Resource).includes('"*"'), "its own group by ARN");
  assert.ok(!actionsOf(egress).some((a) => /Ingress/.test(a)), "never an inbound rule");
  const describe = statements.find((st) => actionsOf(st).includes("ec2:DescribeSecurityGroups"))!;
  assert.deepEqual(actionsOf(describe), ["ec2:DescribeSecurityGroups"]);
  const put = statements.filter((st) => actionsOf(st).includes("dynamodb:PutItem") && JSON.stringify(st.Resource).includes("table/zudocs-desk-events") && actionsOf(st).length === 1);
  assert.equal(put.length, 1, "the wire writes the timeline and nothing else");
  sharedHost.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)", Targets: [Match.objectLike({ Input: JSON.stringify({ action: "tick" }) })] });
  for (const output of ["InstanceId", "HostId", "SecurityGroupId", "WireFunctionName", "AgentKeyParameterName", "LogGroupName"]) sharedHost.hasOutput(output, {});
  sharedHost.hasOutput("HostId", { Value: "eu-west-1/ec2" });
  sharedHost.hasOutput("AgentKeyParameterName", { Value: "/zudocs/dev/agent-key" });
});

test("user data rendering: every placeholder replaced, none left, nothing shell-hostile, never a key; the committed template renders with the committed pins", () => {
  assert.equal(renderUserData("a __X__ b __X__", { X: "1" }), "a 1 b 1");
  assert.throws(() => renderUserData("a __X__ __Y__", { X: "1" }), /left unrendered: __Y__/);
  assert.throws(() => renderUserData("__X__", { X: "a b" }), /shell would misread/);
  assert.throws(() => renderUserData("__X__", { X: "$(rm)" }), /shell would misread/);
  assert.throws(() => renderUserData("AIRPROMPTER_AGENT_KEY=__X__", { X: "1" }), /carry a key/);
  const pins = readPins();
  const rendered = renderUserData(readFileSync(USER_DATA_TEMPLATE, "utf8"), { CLI_URL: pins.cli.url, CLI_SHA256: pins.cli.sha256, BUNDLE_S3_URL: "s3://bucket/key.zip", EXCHANGE_BUCKET: "zudocs-exchange-111122223333" });
  assert.ok(rendered.includes(`echo "${pins.cli.sha256}  /tmp/airprompter.bin" | sha256sum -c -`));
  assert.ok(rendered.includes("sed 's#@EXCHANGE_BUCKET@#zudocs-exchange-111122223333#'"), "the boot fills the bucket into zudocs.env");
  assert.ok(rendered.includes("zudocs-import.timer"), "the import timer is installed and enabled");
  assert.ok(rendered.startsWith("#!/bin/bash"));
  assert.equal(PINS.pythonSdk.packages.length, 5);
});
