/**
 * The airgap stack pins: a VPC with **no internet gateway, no NAT, no default route** — one private subnet whose
 * route table carries only the two gateway endpoints (S3: the exchange and the asset bucket; DynamoDB: the releases
 * table); an Instance Connect Endpoint whose group is the only thing allowed to reach the host, on 22; a t4g.micro on
 * the pinned image with IMDSv2, no public address, no key pair; a role that can read the exchange's releases and
 * tools, write exactly the public key object, the status document and the exports, query the table, read the
 * bundle — and nothing that talks to the world (no SSM, no logs, no Bedrock); user data rendered with the pinned
 * digests and no key; the stack outside CI's deploy list.
 *
 * @example
 * ```sh
 * npx tsx --test test/airgap-stack.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Match } from "aws-cdk-lib/assertions";
import { AIRGAP_USER_DATA_TEMPLATE } from "../lib/airgap-stack.js";
import { STACK_IDS } from "../lib/app.js";
import { AIRGAP_ROLE_NAME, EXCHANGE, readAirgapPins } from "../lib/fleet-names.js";
import { readPins } from "../lib/shared-host-names.js";
import { renderUserData } from "../lib/shared-host-stack.js";
import { AIRGAP_PINS, actionsOf, statementsOf, synthAll, type Resources } from "./fixtures.js";

test("the stack is in ap-southeast-1 after the fleet stack; the VPC has no internet gateway, no NAT, no route out; two gateway endpoints with policies naming the exchange, the asset bucket and the table", () => {
  const { airgap, stacks } = synthAll();
  assert.equal(STACK_IDS.airgap, "ZudocsAirgap");
  assert.equal(stacks.airgap.region, "ap-southeast-1");
  assert.ok(stacks.airgap.dependencies.includes(stacks.fleet), "the bucket and the table exist first");
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::InternetGateway")).length, 0, "no internet gateway");
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::NatGateway")).length, 0, "no NAT");
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::Route")).length, 0, "no route at all: the endpoints add their prefix lists themselves");
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::EIP")).length, 0);
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::Subnet")).length, 1);
  airgap.hasResourceProperties("AWS::EC2::Subnet", { MapPublicIpOnLaunch: false });
  const endpoints = Object.values(airgap.findResources("AWS::EC2::VPCEndpoint") as Resources);
  assert.equal(endpoints.length, 2);
  for (const e of endpoints) assert.equal(e.Properties.VpcEndpointType, "Gateway", "gateway endpoints only (interface endpoints cost money and are not needed)");
  const s3 = endpoints.find((e) => e.Properties.ServiceName === "com.amazonaws.ap-southeast-1.s3")!;
  const s3Policy = JSON.stringify(s3.Properties.PolicyDocument);
  assert.ok(s3Policy.includes("arn:aws:s3:::zudocs-exchange-111122223333") && s3Policy.includes("cdk-hnb659fds-assets-111122223333-ap-southeast-1"), "the exchange and the deployment's asset bucket");
  assert.ok(!s3Policy.includes('"arn:aws:s3:::*"'), "not every bucket");
  const dynamo = endpoints.find((e) => e.Properties.ServiceName === "com.amazonaws.ap-southeast-1.dynamodb")!;
  assert.ok(JSON.stringify(dynamo.Properties.PolicyDocument).includes("table/zudocs-agent-releases"));
  assert.deepEqual(JSON.parse(JSON.stringify(dynamo.Properties.PolicyDocument)).Statement[0].Action, "dynamodb:Query", "the host only queries");
});

test("the shell: an Instance Connect Endpoint; the host's group admits 22 from the endpoint's group only and nothing else inbound; the endpoint's group reaches the host on 22 only", () => {
  const { airgap } = synthAll();
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::InstanceConnectEndpoint")).length, 1);
  airgap.hasResourceProperties("AWS::EC2::InstanceConnectEndpoint", { PreserveClientIp: false });
  const groups = Object.values(airgap.findResources("AWS::EC2::SecurityGroup") as Resources);
  assert.equal(groups.length, 2);
  const host = groups.find((g) => String(g.Properties.GroupDescription).includes("port 22 from the Instance Connect Endpoint"))!;
  const eice = groups.find((g) => String(g.Properties.GroupDescription).includes("the Instance Connect Endpoint (egress"))!;
  assert.equal(host.Properties.SecurityGroupIngress, undefined, "the host's ingress is a separate rule that names the endpoint's group");
  const ingress = Object.values(airgap.findResources("AWS::EC2::SecurityGroupIngress") as Resources);
  assert.equal(ingress.length, 1, "one inbound rule on the host");
  assert.equal(ingress[0]!.Properties.FromPort, 22);
  assert.equal(ingress[0]!.Properties.IpProtocol, "tcp");
  assert.ok(ingress[0]!.Properties.SourceSecurityGroupId, "from a group, not a CIDR");
  assert.deepEqual(host.Properties.SecurityGroupEgress, [{ CidrIp: "0.0.0.0/0", Description: "HTTPS to the gateway endpoints (no other route exists)", FromPort: 443, IpProtocol: "tcp", ToPort: 443 }]);
  assert.equal(eice.Properties.SecurityGroupEgress, undefined, "the endpoint's egress is one separate rule that names the host's group");
  const egress = Object.values(airgap.findResources("AWS::EC2::SecurityGroupEgress") as Resources);
  assert.equal(egress.length, 1, "the endpoint's egress to the host on 22, nothing else");
  assert.equal(egress[0]!.Properties.FromPort, 22);
  assert.ok(egress[0]!.Properties.DestinationSecurityGroupId, "to a group, not a CIDR");
});

test("the instance: t4g.micro on the pinned image, IMDSv2, no public address, 8 GiB gp3 encrypted, no key pair; user data with the pinned digests, the tools from the exchange, the keygen, never a key", () => {
  const { airgap } = synthAll();
  airgap.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t4g.micro", ImageId: "ami-033ccd61cb71cb72b", Monitoring: false, BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 8, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }] });
  const [instance] = Object.values(airgap.findResources("AWS::EC2::Instance") as Resources);
  assert.equal(instance!.Properties.NetworkInterfaces?.[0]?.AssociatePublicIpAddress, false);
  airgap.hasResourceProperties("AWS::EC2::LaunchTemplate", { LaunchTemplateData: Match.objectLike({ MetadataOptions: { HttpTokens: "required" } }) });
  assert.equal(Object.keys(airgap.findResources("AWS::EC2::KeyPair")).length, 0, "no key pair: Instance Connect pushes a key per session");
  const [instanceId] = Object.keys(airgap.findResources("AWS::EC2::Instance"));
  const dependsOn = (airgap.toJSON().Resources as Record<string, { DependsOn?: string[] }>)[instanceId!]!.DependsOn ?? [];
  assert.ok(dependsOn.includes("S3Endpoint") && dependsOn.includes("DynamoEndpoint") && dependsOn.includes("PrivateRouteAssociation"), `the instance waits for the endpoints (${dependsOn.join(", ")})`);
  const userData = Buffer.from(JSON.stringify(instance!.Properties.UserData)).toString("utf8");
  assert.ok(!/__[A-Z0-9_]+__/.test(userData), "every placeholder rendered");
  assert.ok(!/AIRPROMPTER_AGENT_KEY=|apa_|dnf |curl -fsSL/.test(userData), "no key, no package install, no download from the world");
  assert.ok(userData.includes(`tools/${AIRGAP_PINS.node.asset}`) && userData.includes(AIRGAP_PINS.node.sha256), "Node from the exchange, verified");
  assert.ok(userData.includes("tools/airprompter-linux-arm64") && userData.includes("f".repeat(64)), "the CLI from the exchange, verified");
  assert.ok(userData.includes("zudocs-airgap-keygen") && userData.includes("zudocs-airgap-probe"), "the keypair is born at boot; the probe runs");
  assert.ok(userData.includes("sed 's#@EXCHANGE_BUCKET@#zudocs-exchange-111122223333#'"));
});

test("the instance role: the exchange's exact keys (read releases/tools, write the public key, the status and the exports — never a private key's path), the table's query, the bundle; no SSM, no logs, no Bedrock, no wildcard", () => {
  const { airgap } = synthAll();
  airgap.hasResourceProperties("AWS::IAM::Role", { RoleName: AIRGAP_ROLE_NAME });
  const [role] = Object.values(airgap.findResources("AWS::IAM::Role", { Properties: { RoleName: AIRGAP_ROLE_NAME } }) as Resources);
  assert.equal(role!.Properties.ManagedPolicyArns, undefined);
  const statements = statementsOf(airgap);
  const actions = statements.flatMap(actionsOf);
  assert.ok(!actions.some((a) => a.startsWith("ssm") || a.startsWith("logs:") || a.startsWith("bedrock") || a.startsWith("ec2messages") || a === "*"), `nothing that talks to the world: ${actions.join(", ")}`);
  const read = statements.find((st) => st.Sid === "ExchangeRead")!;
  assert.deepEqual(actionsOf(read), ["s3:GetObject"]);
  assert.deepEqual([...(read.Resource as string[])].sort(), ["arn:aws:s3:::zudocs-exchange-111122223333/latest.json", "arn:aws:s3:::zudocs-exchange-111122223333/releases/*", "arn:aws:s3:::zudocs-exchange-111122223333/tools/*"]);
  const write = statements.find((st) => st.Sid === "ExchangeWrite")!;
  assert.deepEqual(actionsOf(write), ["s3:PutObject"]);
  assert.deepEqual([...(write.Resource as string[])].sort(), [`arn:aws:s3:::zudocs-exchange-111122223333/${EXCHANGE.publicKey}`, `arn:aws:s3:::zudocs-exchange-111122223333/${EXCHANGE.status}`, "arn:aws:s3:::zudocs-exchange-111122223333/telemetry/*"].sort());
  assert.ok(!JSON.stringify(write.Resource).includes("key.json"), "the private half's name is not a writable path");
  assert.ok(!JSON.stringify(write.Resource).includes("keys/*"), "no glob over keys/");
  const table = statements.find((st) => st.Sid === "ReleasesRead")!;
  assert.deepEqual(actionsOf(table), ["dynamodb:Query"]);
  assert.equal(table.Resource, "arn:aws:dynamodb:ap-southeast-1:111122223333:table/zudocs-agent-releases");
  const asset = statements.filter((st) => actionsOf(st).includes("s3:GetObject*") || actionsOf(st).includes("s3:GetBucket*"));
  assert.equal(asset.length, 1, "the bundle from the asset bucket");
});

test("user data rendering with the committed template and pins; the outputs the owner's script reads", () => {
  const pins = readPins();
  const airgapPins = readAirgapPins();
  const rendered = renderUserData(readFileSync(AIRGAP_USER_DATA_TEMPLATE, "utf8"), { REGION: "ap-southeast-1", EXCHANGE_BUCKET: "zudocs-exchange-111122223333", TOOLS_PREFIX: EXCHANGE.toolsPrefix, PUBLIC_KEY_OBJECT: EXCHANGE.publicKey, NODE_ASSET: airgapPins.node.asset, NODE_SHA256: airgapPins.node.sha256, CLI_ASSET: pins.cli.asset, CLI_SHA256: pins.cli.sha256, BUNDLE_S3_URL: "s3://bucket/key.zip" });
  assert.ok(rendered.startsWith("#!/bin/bash"));
  assert.ok(rendered.includes(`echo "${airgapPins.node.sha256}  /tmp/node.tar.gz" | sha256sum -c -`));
  assert.ok(rendered.includes(`echo "${pins.cli.sha256}  /tmp/airprompter.bin" | sha256sum -c -`));
  assert.ok(rendered.includes('EXCHANGE="s3://zudocs-exchange-111122223333"') && rendered.includes(`\${EXCHANGE}/tools/${airgapPins.node.asset}`), "Node from the exchange's tools/ prefix");
  const { airgap } = synthAll();
  const outputs = airgap.toJSON().Outputs as Record<string, { Value: unknown }>;
  for (const key of ["InstanceId", "HostId", "InstanceConnectEndpointId", "ShellCommand", "RouteTableId", "ExchangeBucketName", "PublicKeyObject"]) assert.ok(outputs[key], key);
  assert.equal(outputs.HostId!.Value, "ap-southeast-1/airgap");
});

test("CI's deploy list carries the fleet stack and never the airgap stack", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const deployLine = workflow.split("\n").find((line) => line.includes("npx cdk deploy"))!;
  assert.ok(deployLine.includes("ZudocsFleet"), "the fleet stack is deployed by CI");
  assert.ok(!deployLine.includes("ZudocsAirgap"), "the airgap stack is deployed on demand by the owner");
  assert.ok(deployLine.indexOf("ZudocsFleet") < deployLine.indexOf("ZudocsDesk"), "the fleet before the desk (the desk names the queue)");
});
