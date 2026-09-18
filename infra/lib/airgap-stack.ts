/**
 * The ap-southeast-1 air-gapped host, deployed on demand (`npm run airgap:up` / `airgap:down` from the owner's
 * profile — never by CI): one t4g.micro in a VPC that has **no internet gateway and no NAT** — no route out at all.
 * What it can reach is exactly what the route table names: the region's S3 and DynamoDB through **gateway endpoints**
 * (free; their policies name the exchange bucket, the deployment's asset bucket and the releases table), and a shell
 * for the owner through an **EC2 Instance Connect Endpoint** (free; the only inbound rule on the host is port 22 from
 * the endpoint's own security group). IMDSv2 is required. The host has no Agent key, no SSM agent connectivity, no
 * CloudWatch: its status document and its telemetry exports go to the exchange bucket and the puller mirrors them.
 *
 * The first boot cannot `dnf install` anything (`services/airgap/host/user-data.sh`): Node and the released CLI come
 * from `tools/` in the exchange bucket, where `npm run airgap:up` staged them, and are verified against the pinned
 * digests before either runs; the worker bundle comes from the deployment's asset bucket through the same endpoint.
 * Then the host generates its distribution keypair (`airprompter keygen --purpose distribution`, under
 * `/var/lib/airprompter/keys`, never a git directory), keeps the private half at 0600 and publishes only the public
 * half to the exchange; the instance role can put exactly that one key object, so the private half cannot leave
 * even by mistake. A change to the bundle, the boot script or the pinned image replaces the instance — a new host,
 * a new keypair, a re-seal by the puller.
 *
 * @example
 * ```ts
 * new AirgapStack(app, "ZudocsAirgap", { config, env: { account, region: config.regions.fleet }, assets: { airgapBundle: "…/services/airgap/dist/bundle" }, airprompter: ids });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_dynamodb as dynamodb, aws_ec2 as ec2, aws_iam as iam, aws_s3 as s3, aws_s3_assets as assets } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZudocsConfig } from "./config.js";
import type { AirPrompterIds } from "./desk-stack.js";
import { AIRGAP_HOST_ID, AIRGAP_ROLE_NAME, EXCHANGE, RELEASES_TABLE_NAME, exchangeBucketName, readAirgapPins, type AirgapPins } from "./fleet-names.js";
import { readPins, type Pins } from "./shared-host-names.js";
import { renderUserData } from "./shared-host-stack.js";

export interface AirgapStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
  /** The built host bundle (`services/airgap/dist/bundle`). */
  readonly assets: { readonly airgapBundle: string };
  readonly airprompter: AirPrompterIds;
  /** The fleet's pins (`services/eu-host/pins.json` for the CLI) and the host's own (`services/airgap/pins.json`); the defaults read the files. */
  readonly pins?: Pins;
  readonly airgapPins?: AirgapPins;
}

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const AIRGAP_USER_DATA_TEMPLATE = join(repoRoot, "services", "airgap", "host", "user-data.sh");

export class AirgapStack extends cdk.Stack {
  readonly instance: ec2.Instance;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AirgapStackProps) {
    super(scope, id, props);
    const { config } = props;
    const pins = props.pins ?? readPins();
    const airgapPins = props.airgapPins ?? readAirgapPins();
    for (const [name, path] of Object.entries(props.assets)) if (!existsSync(path)) throw new Error(`airgap stack: the ${name} artefact is missing at ${path} — run \`npm run build\` first`);
    const bucketName = exchangeBucketName(this.account);
    const exchange = s3.Bucket.fromBucketName(this, "ExchangeRef", bucketName);
    const releases = dynamodb.Table.fromTableName(this, "ReleasesRef", RELEASES_TABLE_NAME);

    // --- The network: one private subnet, no gateway of any kind, two gateway endpoints, one Instance Connect Endpoint
    // L1 on purpose (the `Vpc` construct's zone lookup breaks the credential-less synth); the zone is the region's first.
    const zone = cdk.Fn.select(0, cdk.Fn.getAzs(this.region));
    const cfnVpc = new ec2.CfnVPC(this, "Vpc", { cidrBlock: "10.43.0.0/16", enableDnsHostnames: true, enableDnsSupport: true, tags: [{ key: "Name", value: "zudocs-airgap" }] });
    const cfnSubnet = new ec2.CfnSubnet(this, "PrivateSubnet", { vpcId: cfnVpc.ref, cidrBlock: "10.43.0.0/24", availabilityZone: zone, mapPublicIpOnLaunch: false, tags: [{ key: "Name", value: "zudocs-airgap/private" }] });
    const routeTable = new ec2.CfnRouteTable(this, "PrivateRouteTable", { vpcId: cfnVpc.ref, tags: [{ key: "Name", value: "zudocs-airgap/private (no default route)" }] });
    const association = new ec2.CfnSubnetRouteTableAssociation(this, "PrivateRouteAssociation", { subnetId: cfnSubnet.ref, routeTableId: routeTable.ref });
    const vpc = ec2.Vpc.fromVpcAttributes(this, "VpcRef", { vpcId: cfnVpc.ref, availabilityZones: [zone], privateSubnetIds: [cfnSubnet.ref], privateSubnetRouteTableIds: [routeTable.ref] });

    // --- The worker bundle (the asset bucket is reachable through the S3 endpoint below) ------------------------------
    const bundle = new assets.Asset(this, "HostBundle", { path: props.assets.airgapBundle });
    const assetBucketArn = `arn:${this.partition}:s3:::${bundle.s3BucketName}`;

    // The S3 endpoint: the exchange bucket and the deployment's asset bucket, nothing else; the DynamoDB endpoint: the
    // releases table. A host that could reach any bucket through the endpoint would have a route out after all.
    const s3Endpoint = new ec2.CfnVPCEndpoint(this, "S3Endpoint", {
      vpcId: cfnVpc.ref,
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcEndpointType: "Gateway",
      routeTableIds: [routeTable.ref],
      policyDocument: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ principals: [new iam.AnyPrincipal()], actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], resources: [exchange.bucketArn, exchange.arnForObjects("*"), assetBucketArn, `${assetBucketArn}/*`] })] }),
    });
    const dynamoEndpoint = new ec2.CfnVPCEndpoint(this, "DynamoEndpoint", {
      vpcId: cfnVpc.ref,
      serviceName: `com.amazonaws.${this.region}.dynamodb`,
      vpcEndpointType: "Gateway",
      routeTableIds: [routeTable.ref],
      policyDocument: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ principals: [new iam.AnyPrincipal()], actions: ["dynamodb:Query"], resources: [releases.tableArn] })] }),
    });

    // --- The shell: an Instance Connect Endpoint in the subnet; port 22 on the host from the endpoint's group only ---
    const eiceGroup = new ec2.SecurityGroup(this, "EiceGroup", { vpc, description: "Zudocs air-gapped host: the Instance Connect Endpoint (egress to the host on 22 only)", allowAllOutbound: false });
    const hostGroup = new ec2.SecurityGroup(this, "HostGroup", { vpc, description: "Zudocs air-gapped host: port 22 from the Instance Connect Endpoint only; egress on 443 (the route table has no route out)", allowAllOutbound: false });
    hostGroup.addIngressRule(eiceGroup, ec2.Port.tcp(22), "SSH from the Instance Connect Endpoint");
    eiceGroup.addEgressRule(hostGroup, ec2.Port.tcp(22), "to the host on 22");
    // HTTPS to anywhere at the group: the gateway endpoints' prefix lists are a deploy-time lookup a credential-less
    // synth cannot make. The boundary is the route table, which has no route out; the proof shows both.
    hostGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS to the gateway endpoints (no other route exists)");
    const eice = new ec2.CfnInstanceConnectEndpoint(this, "Eice", { subnetId: cfnSubnet.ref, securityGroupIds: [eiceGroup.securityGroupId], preserveClientIp: false, tags: [{ key: "Name", value: "zudocs-airgap" }] });

    // --- The instance role: the exchange's exact keys, the bundle, the releases table — and nothing that talks to the world
    this.role = new iam.Role(this, "HostRole", { roleName: AIRGAP_ROLE_NAME, assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"), description: "Zudocs air-gapped host: the exchange bucket's exact keys, the boot bundle, the releases table; no SSM, no logs, no models" });
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "ExchangeRead", actions: ["s3:GetObject"], resources: [exchange.arnForObjects(`${EXCHANGE.releasesPrefix}*`), exchange.arnForObjects(EXCHANGE.latest), exchange.arnForObjects(`${EXCHANGE.toolsPrefix}*`)] }));
    // Exactly the public half of the key, the status document and the exports: the private key's path is not writable by this role.
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "ExchangeWrite", actions: ["s3:PutObject"], resources: [exchange.arnForObjects(EXCHANGE.publicKey), exchange.arnForObjects(EXCHANGE.status), exchange.arnForObjects(`${EXCHANGE.telemetryPrefix}*`)] }));
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "ReleasesRead", actions: ["dynamodb:Query"], resources: [releases.tableArn] }));
    // The bundle: exactly this object in the deployment's asset bucket (not `grantRead`, which lists the whole bucket).
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "BundleRead", actions: ["s3:GetObject"], resources: [`${assetBucketArn}/${bundle.s3ObjectKey}`] }));

    // --- The boot script ------------------------------------------------------------------------------------------------
    const userData = renderUserData(readFileSync(AIRGAP_USER_DATA_TEMPLATE, "utf8"), {
      REGION: this.region,
      EXCHANGE_BUCKET: bucketName,
      TOOLS_PREFIX: EXCHANGE.toolsPrefix,
      PUBLIC_KEY_OBJECT: EXCHANGE.publicKey,
      NODE_ASSET: airgapPins.node.asset,
      NODE_SHA256: airgapPins.node.sha256,
      CLI_ASSET: pins.cli.asset,
      CLI_SHA256: pins.cli.sha256,
      BUNDLE_S3_URL: bundle.s3ObjectUrl,
    });

    // --- The instance -----------------------------------------------------------------------------------------------------
    const ami = airgapPins.ami[this.region];
    if (!ami) throw new Error(`airgap pins.json: no AMI pinned for ${this.region} (services/airgap/pins.json › ami)`);
    this.instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnets: vpc.privateSubnets },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.genericLinux({ [this.region]: ami }, { userData: ec2.UserData.custom(userData) }),
      securityGroup: hostGroup,
      role: this.role,
      requireImdsv2: true,
      associatePublicIpAddress: false,
      detailedMonitoring: false,
      instanceName: "zudocs-airgap",
      blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }) }],
      userDataCausesReplacement: true,
    });
    // The boot's first act is an S3 read through the endpoint: the instance waits for the endpoints and the route association.
    this.instance.node.addDependency(s3Endpoint, dynamoEndpoint, association);

    new cdk.CfnOutput(this, "InstanceId", { value: this.instance.instanceId });
    new cdk.CfnOutput(this, "HostId", { value: AIRGAP_HOST_ID, description: "The host's row in the status table (mirrored by the puller)" });
    new cdk.CfnOutput(this, "InstanceConnectEndpointId", { value: eice.attrId });
    new cdk.CfnOutput(this, "ShellCommand", { value: `aws ec2-instance-connect ssh --region ${this.region} --instance-id ${this.instance.instanceId} --connection-type eice --os-user ec2-user`, description: "A shell on the host through the Instance Connect Endpoint (the owner's profile)" });
    new cdk.CfnOutput(this, "RouteTableId", { value: routeTable.ref, description: "Has no route out: local plus the two gateway endpoints' prefix lists" });
    new cdk.CfnOutput(this, "SubnetId", { value: cfnSubnet.ref });
    new cdk.CfnOutput(this, "ExchangeBucketName", { value: bucketName });
    new cdk.CfnOutput(this, "PublicKeyObject", { value: `s3://${bucketName}/${EXCHANGE.publicKey}`, description: "The public half of the distribution key the host generated at first boot; the private half never leaves" });
  }
}
