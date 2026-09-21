/**
 * The eu-west-1 shared host: one t4g.micro (Amazon Linux 2023, arm64) running `airprompterd` with two workers
 * attached — the production host that shows a resident daemon, `file_key` honestly, `unlock_required` and the
 * operator's CLI. What the stack holds:
 *
 * - A VPC of one public subnet in one zone, no NAT, no interface endpoints (nothing to pay for standing still); a
 *   security group with **no inbound rule at all** and open egress — the wire function replaces that egress for the
 *   drill and a rule puts it back within `WIRE_CUT_MAX_MINUTES`.
 * - The instance: IMDSv2 required, 8 GiB gp3 encrypted root, a public IPv4 for egress, SSM Session Manager through
 *   the instance role (no key pair, no port 22). Its role reads exactly one SSM parameter (the Agent key, in this
 *   region, by name — the AWS-managed SSM key decrypts it, so no KMS key is paid for here), the boot bundle from the
 *   deployment's asset bucket, the catalogue's models on Bedrock in the desk's region, the desk's eight tables by ARN
 *   across regions, the telemetry exports in the fleet's exchange bucket (the import timer, phase 5), and its own log group. Its name is fixed so the desk stack's Budgets action can attach the
 *   Bedrock deny policy to it too.
 * - User data rendered from `services/eu-host/host/user-data.sh`: the released CLI verified against the pinned
 *   digest, the bundle, the Python venv by commit pin, the units, the CloudWatch agent. A change to the bundle, the
 *   script or the pinned AMI replaces the instance (`userDataCausesReplacement`): the host is cattle, its store is
 *   rebuilt from a sync — and, under `unlock_required`, the first release lands staged for the desk to approve.
 * - The wire function (Node 22 arm64, `services/eu-host/src/wire.ts`) with the EventBridge tick every five minutes.
 * - The desk's host-CLI Run Command document (phase 6 addendum): a Command document in this region whose one
 *   parameter's allowed values are exactly the desk's allowlist (`services/desk-api/src/hostCliDocument.ts`) and whose
 *   shell line is fixed — the desk function may send this document and no other, so its role is never arbitrary
 *   root on a host that holds the Agent key.
 *
 * Two things a synth cannot catch: the eu-west SSM parameter must exist before the daemon can start (the boot writes
 * the env file from it and fails loudly otherwise; `AWS_REGION=eu-west-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash
 * scripts/ssm-put-agent-key.sh`), and the first boot takes ten minutes (pip resolves LiteLLM on one vCPU).
 *
 * @example
 * ```ts
 * new SharedHostStack(app, "ZudocsSharedHost", { config, env: { account, region: config.regions.sharedHost }, assets: { euHostBundle: "…/services/eu-host/dist/bundle", wire: "…/services/eu-host/dist/wire" }, airprompter: ids });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_ec2 as ec2, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3_assets as assets, aws_ssm as ssm } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_CLI_DOCUMENT_NAME, hostCliDocumentContent } from "../../services/desk-api/src/hostCliDocument.js";
import { CATALOGUE } from "../../services/desk-api/src/modelCatalogue.js";
import type { ZudocsConfig } from "./config.js";
import { TABLE_NAMES, tableNameOf, type AirPrompterIds } from "./desk-stack.js";
import { EXCHANGE, exchangeBucketName } from "./fleet-names.js";
import { EU_HOST_LOG_GROUP, EU_HOST_NAME_TAG, EU_HOST_ROLE_NAME, WIRE_CUT_MAX_MINUTES, WIRE_FUNCTION_NAME, readPins, type Pins } from "./shared-host-names.js";

export interface SharedHostStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
  /** Built artefacts: the host bundle directory and the wire function's directory (`services/eu-host/dist`). */
  readonly assets: { readonly euHostBundle: string; readonly wire: string };
  readonly airprompter: AirPrompterIds;
  /** The pins (`services/eu-host/pins.json`); the default reads the file. */
  readonly pins?: Pins;
}

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const USER_DATA_TEMPLATE = join(repoRoot, "services", "eu-host", "host", "user-data.sh");

/** The boot script from its template: every `__NAME__` replaced, none left behind, never a key. Pure. */
export function renderUserData(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    if (/[\s"'`$\\]/.test(value)) throw new Error(`user data: ${name} holds a character the shell would misread`);
    rendered = rendered.split(`__${name}__`).join(value);
  }
  const left = rendered.match(/__[A-Z0-9_]+__/g);
  if (left) throw new Error(`user data: placeholders left unrendered: ${[...new Set(left)].join(", ")}`);
  if (/apa_[A-Za-z0-9_]{8,}|AIRPROMPTER_AGENT_KEY=/.test(rendered)) throw new Error("user data: the script would carry a key");
  return rendered;
}

export class SharedHostStack extends cdk.Stack {
  readonly instance: ec2.Instance;
  readonly securityGroup: ec2.SecurityGroup;
  readonly wire: lambda.Function;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: SharedHostStackProps) {
    super(scope, id, props);
    const { config, airprompter } = props;
    const pins = props.pins ?? readPins();
    for (const [name, path] of Object.entries(props.assets)) if (!existsSync(path)) throw new Error(`shared host stack: the ${name} artefact is missing at ${path} — run \`npm run build\` first`);
    const hostId = `${this.region}/ec2`;
    const tablesRegion = config.regions.site;

    // --- The network: one public subnet, no NAT, no endpoints; a group with no inbound rule ---------------------
    // Built from the L1 resources on purpose: the `Vpc` construct reads the account's zone list at synth (a context
    // lookup), and a credential-less `npm run synth` must pass. The zone is CloudFormation's first (Fn::GetAZs).
    const zone = cdk.Fn.select(0, cdk.Fn.getAzs(this.region));
    const cfnVpc = new ec2.CfnVPC(this, "Vpc", { cidrBlock: "10.42.0.0/16", enableDnsHostnames: true, enableDnsSupport: true, tags: [{ key: "Name", value: "zudocs-eu-host" }] });
    const igw = new ec2.CfnInternetGateway(this, "Igw", {});
    const attached = new ec2.CfnVPCGatewayAttachment(this, "IgwAttachment", { vpcId: cfnVpc.ref, internetGatewayId: igw.ref });
    const cfnSubnet = new ec2.CfnSubnet(this, "PublicSubnet", { vpcId: cfnVpc.ref, cidrBlock: "10.42.0.0/24", availabilityZone: zone, mapPublicIpOnLaunch: true, tags: [{ key: "Name", value: "zudocs-eu-host/public" }] });
    const routeTable = new ec2.CfnRouteTable(this, "PublicRouteTable", { vpcId: cfnVpc.ref });
    const route = new ec2.CfnRoute(this, "PublicRoute", { routeTableId: routeTable.ref, destinationCidrBlock: "0.0.0.0/0", gatewayId: igw.ref });
    route.addResourceDependency(attached);
    const association = new ec2.CfnSubnetRouteTableAssociation(this, "PublicRouteAssociation", { subnetId: cfnSubnet.ref, routeTableId: routeTable.ref });
    const vpc = ec2.Vpc.fromVpcAttributes(this, "VpcRef", { vpcId: cfnVpc.ref, availabilityZones: [zone], publicSubnetIds: [cfnSubnet.ref], publicSubnetRouteTableIds: [routeTable.ref] });
    this.securityGroup = new ec2.SecurityGroup(this, "HostGroup", { vpc, description: "Zudocs eu-west host: no inbound; egress replaced by the wire function for the drill", allowAllOutbound: true });
    cdk.Tags.of(this.securityGroup).add("zudocs:wire", "managed");

    // --- The instance role: SSM, one parameter, the bundle, the models, the desk's tables, its log group ---------
    const parameterName = `/zudocs/${airprompter.environment}/agent-key`;
    const logGroup = new logs.LogGroup(this, "HostLogs", { logGroupName: EU_HOST_LOG_GROUP, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    this.role = new iam.Role(this, "HostRole", {
      roleName: EU_HOST_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Zudocs eu-west host: Session Manager, the Agent key parameter, the boot bundle, Bedrock, the desk's tables, its logs",
    });
    // Session Manager and Run Command by their own actions — not AmazonSSMManagedInstanceCore, which also grants
    // ssm:GetParameter(s) on every parameter in the account; this host may read exactly one, below.
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "SessionManager", actions: ["ssm:UpdateInstanceInformation", "ssm:ListAssociations", "ssm:ListInstanceAssociations", "ssm:DescribeAssociation", "ssm:GetDocument", "ssm:DescribeDocument", "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssm:PutInventory", "ssm:PutComplianceItems", "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply"], resources: ["*"] }));
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: parameterName.slice(1) })] }));
    const tableArns = TABLE_NAMES.flatMap((name) => {
      const arn = `arn:${this.partition}:dynamodb:${tablesRegion}:${this.account}:table/${tableNameOf(name)}`;
      return name === "runs" ? [arn, `${arn}/index/*`] : [arn];
    });
    // Scan is used, not a leftover: the worker reads the whole (small) inbox, status and approvals tables (`listTickets`, `listStatus`, `listApprovals`).
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"], resources: tableArns }));
    const foundationModels = [...new Set(Object.values(CATALOGUE).map((m) => m.foundationModelId))].map((id) => `arn:${this.partition}:bedrock:*::foundation-model/${id}`);
    const profiles = Object.values(CATALOGUE).filter((m) => m.bedrockId !== m.foundationModelId).map((m) => `arn:${this.partition}:bedrock:${tablesRegion}:${this.account}:inference-profile/${m.bedrockId}`);
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"], resources: [...foundationModels, ...profiles] }));
    if (Object.values(CATALOGUE).some((m) => m.path === "mantle")) {
      this.role.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock-mantle:CreateInference"], resources: [`arn:${this.partition}:bedrock-mantle:${tablesRegion}:${this.account}:project/default`] }));
    }
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`] }));
    // The air-gapped host's telemetry exports in the exchange bucket (ap-southeast-1), read by the import timer: the
    // telemetry/ prefix, its ledger of markers under imports/ (written once per export), and a listing of those two prefixes only.
    const exchangeArn = `arn:${this.partition}:s3:::${exchangeBucketName(this.account)}`;
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "ExchangeTelemetryRead", actions: ["s3:GetObject"], resources: [`${exchangeArn}/${EXCHANGE.telemetryPrefix}*`] }));
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "ExchangeImportsWrite", actions: ["s3:PutObject"], resources: [`${exchangeArn}/${EXCHANGE.importsPrefix}*`] }));
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "ExchangeTelemetryList", actions: ["s3:ListBucket"], resources: [exchangeArn], conditions: { StringLike: { "s3:prefix": [`${EXCHANGE.telemetryPrefix}*`, `${EXCHANGE.importsPrefix}*`] } } }));
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:DescribeLogGroups"], resources: ["*"] }));

    // --- The boot bundle and the script ----------------------------------------------------------------------------
    const bundle = new assets.Asset(this, "HostBundle", { path: props.assets.euHostBundle });
    bundle.grantRead(this.role);
    const userData = renderUserData(readFileSync(USER_DATA_TEMPLATE, "utf8"), { CLI_URL: pins.cli.url, CLI_SHA256: pins.cli.sha256, BUNDLE_S3_URL: bundle.s3ObjectUrl, EXCHANGE_BUCKET: exchangeBucketName(this.account) });

    // --- The instance --------------------------------------------------------------------------------------------
    const ami = pins.ami[this.region];
    if (!ami) throw new Error(`pins.json: no AMI pinned for ${this.region} (services/eu-host/pins.json › ami)`);
    this.instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnets: vpc.publicSubnets },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      // Pinned (`pins.json`), not resolved at deploy: an image refresh would replace the instance — and its store —
      // on the next CI deploy, which is a deliberate act here, not a side effect.
      machineImage: ec2.MachineImage.genericLinux({ [this.region]: ami }, { userData: ec2.UserData.custom(userData) }),
      securityGroup: this.securityGroup,
      role: this.role,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      detailedMonitoring: false,
      instanceName: EU_HOST_NAME_TAG,
      blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }) }],
      userDataCausesReplacement: true,
    });
    // The boot's first acts are network calls (dnf, GitHub, S3): the instance waits for its route to the internet.
    this.instance.node.addDependency(logGroup, route, association, attached);

    // --- The wire function and its tick ------------------------------------------------------------------------------
    const eventsTableArn = `arn:${this.partition}:dynamodb:${tablesRegion}:${this.account}:table/${tableNameOf("events")}`;
    this.wire = new lambda.Function(this, "Wire", {
      functionName: WIRE_FUNCTION_NAME,
      description: "Zudocs: cuts and restores the eu-west host's egress at its security group; the tick restores a forgotten cut",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(props.assets.wire),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, "WireLogs", { logGroupName: `/aws/lambda/${WIRE_FUNCTION_NAME}`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: {
        SECURITY_GROUP_ID: this.securityGroup.securityGroupId,
        HOST_ID: hostId,
        DYNAMODB_REGION: tablesRegion,
        EVENTS_TABLE: tableNameOf("events"),
        WIRE_CUT_MAX_MINUTES: String(WIRE_CUT_MAX_MINUTES),
      },
    });
    const groupArn = this.formatArn({ service: "ec2", resource: "security-group", resourceName: this.securityGroup.securityGroupId });
    this.wire.addToRolePolicy(new iam.PolicyStatement({ actions: ["ec2:DescribeSecurityGroups"], resources: ["*"] }));
    this.wire.addToRolePolicy(new iam.PolicyStatement({ actions: ["ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags"], resources: [groupArn] }));
    this.wire.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [eventsTableArn] }));
    new events.Rule(this, "WireTick", { description: "Zudocs: restore the eu-west host's egress when a cut is older than the limit", schedule: events.Schedule.rate(cdk.Duration.minutes(5)), targets: [new targets.LambdaFunction(this.wire, { event: events.RuleTargetInput.fromObject({ action: "tick" }) })] });

    // --- The desk's host-CLI document ---------------------------------------------------------------------------
    // A change to the allowlist is a new document version (the default follows); the desk stack grants SendCommand on this ARN only.
    new ssm.CfnDocument(this, "HostCliDocument", {
      name: HOST_CLI_DOCUMENT_NAME,
      documentType: "Command",
      documentFormat: "JSON",
      targetType: "/AWS::EC2::Instance",
      updateMethod: "NewVersion",
      content: hostCliDocumentContent(),
    });

    new cdk.CfnOutput(this, "InstanceId", { value: this.instance.instanceId });
    new cdk.CfnOutput(this, "HostId", { value: hostId, description: "The host's row in the status table" });
    new cdk.CfnOutput(this, "SecurityGroupId", { value: this.securityGroup.securityGroupId });
    new cdk.CfnOutput(this, "WireFunctionName", { value: this.wire.functionName });
    new cdk.CfnOutput(this, "AgentKeyParameterName", { value: parameterName, description: `Write the Agent key here in ${this.region} as a SecureString (AWS_REGION=${this.region} ZUDOCS_SSM_KEY_ID=alias/aws/ssm scripts/ssm-put-agent-key.sh)` });
    new cdk.CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
  }
}
