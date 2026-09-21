/**
 * The desk stack pins: every route the handler matches is registered and every one carries the JWT authorizer
 * (both clients as audiences), the stage throttles, the function is Node 22 on arm64 with reserved concurrency 5,
 * seven-day logs and a `/tmp` state directory, its environment holds the Agent key parameter's NAME and nothing
 * key-shaped, its IAM reaches exactly the catalogue's models, one parameter and the key under encryption-context
 * conditions, the tables are on-demand and private, the desk bucket blocks public access behind a strict CSP, and
 * the Budgets action attaches the site's deny policy at 100 % of the monthly budget.
 *
 * @example
 * ```sh
 * npx tsx --test test/desk-stack.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import { CATALOGUE } from "../../services/desk-api/src/modelCatalogue.js";
import { ROUTES } from "../../services/desk-api/src/router.js";
import { buildStacks, STACK_IDS } from "../lib/app.js";
import { readConfig } from "../lib/config.js";
import { HOST_CLI_DOCUMENT_NAME } from "../../services/desk-api/src/hostCliDocument.js";
import { DAILY_RUN_CAP, dailyRunCapOf, readAirPrompterIds } from "../lib/desk-stack.js";
import { CONTEXT, FLAGS, IDS, PINS, actionsOf, fixtures, statementsOf, synthAll, type Resources } from "./fixtures.js";

const synth = synthAll;

test("the desk stack is on the app, depends on the site (its pool, certificate, deny policy), the zone and the shared host (the role and function it names), and refuses to synthesize without the built artefacts", () => {
  const { stacks } = synth();
  assert.equal(STACK_IDS.desk, "ZudocsDesk");
  assert.ok(stacks.desk.dependencies.includes(stacks.site) && stacks.desk.dependencies.includes(stacks.dns));
  assert.ok(stacks.desk.dependencies.includes(stacks.sharedHost), "deployed after the eu-west stack: the Budgets action names its role, the function its wire function");
  const app = new cdk.App({ context: { ...FLAGS, ...CONTEXT } });
  assert.throws(() => buildStacks(app, readConfig(app.node, { BUDGET_EMAIL: "x@y.z" }), { assets: { ...fixtures(), deskApi: "/nonexistent/a", deskSite: "/nonexistent/b" }, airprompter: IDS, pins: PINS }), /run `npm run build` first/);
});

test("every route the handler matches is registered, each with the JWT authorizer; the authorizer trusts the pool and both clients; the stage throttles; CORS names the desk only", () => {
  const { desk } = synth();
  const routes = Object.values(desk.findResources("AWS::ApiGatewayV2::Route") as Resources);
  assert.equal(routes.length, ROUTES.length, "one registered route per handler route");
  const authorizers = Object.keys(desk.findResources("AWS::ApiGatewayV2::Authorizer"));
  assert.equal(authorizers.length, 1);
  for (const route of routes) {
    assert.equal(route.Properties.AuthorizationType, "JWT", route.Properties.RouteKey);
    assert.deepEqual(route.Properties.AuthorizerId, { Ref: authorizers[0] }, route.Properties.RouteKey);
  }
  assert.deepEqual(routes.map((r) => r.Properties.RouteKey).sort(), ROUTES.map((r) => `${r.method} ${r.pattern}`).sort());
  desk.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"], JwtConfiguration: { Audience: [Match.anyValue(), Match.anyValue()], Issuer: Match.anyValue() } });
  const [authorizer] = Object.values(desk.findResources("AWS::ApiGatewayV2::Authorizer") as Resources);
  assert.equal(new Set(JSON.stringify(authorizer!.Properties.JwtConfiguration.Audience).match(/ZudocsSite:ExportsOutput[A-Za-z0-9]+/g)).size, 2, "two distinct client ids imported from the site stack");
  desk.hasResourceProperties("AWS::ApiGatewayV2::Stage", { StageName: "$default", AutoDeploy: true, DefaultRouteSettings: { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 } });
  desk.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://desk.zudocs.com", "http://localhost:5173"], AllowMethods: ["GET", "POST"] }) });
  assert.equal(Object.keys(desk.findResources("AWS::Lambda::Url")).length, 0, "no bare function URL");
});

test("the function: Node 22 on arm64, reserved concurrency 5, five-minute timeout, seven-day logs; the environment carries the parameter's NAME, the cap, and nothing key-shaped", () => {
  const { desk } = synth();
  desk.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "zudocs-desk-api", Runtime: "nodejs22.x", Architectures: ["arm64"], Handler: "index.handler", ReservedConcurrentExecutions: 5, Timeout: 300, MemorySize: 1024 });
  desk.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/zudocs-desk-api", RetentionInDays: 7 });
  const [fn] = Object.values(desk.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "zudocs-desk-api" } }) as Resources);
  const env = fn!.Properties.Environment.Variables as Record<string, unknown>;
  assert.equal(env.AGENT_KEY_PARAMETER, "/zudocs/dev/agent-key", "a name");
  assert.equal(env.DAILY_RUN_CAP, String(DAILY_RUN_CAP));
  assert.equal(env.STATE_EPOCH, "1");
  assert.equal(env.HOST_ID, "us-east-1/lambda");
  assert.equal(env.EMF_NAMESPACE, "Zudocs/Desk");
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!/KEY$|SECRET|TOKEN|PASSWORD/.test(name) || name === "AGENT_KEY_PARAMETER" || name === "KMS_KEY_ID", `${name} looks like a secret's slot`);
    if (typeof value === "string") assert.ok(!/^apa_|^apk_|^eyJ/.test(value), `${name} holds a value that looks like a key`);
  }
  assert.equal(env.AIRPROMPTER_ROOT_JWK, IDS.rootJwk, "the pinned root travels as text");
  assert.ok(!("AIRPROMPTER_AGENT_KEY" in env), "the key itself is never an environment variable");
  const low = synth("owner@example.test", { dailyRunCap: "2" });
  low.desk.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "zudocs-desk-api", Environment: { Variables: Match.objectLike({ DAILY_RUN_CAP: "2" }) } });
  assert.throws(() => dailyRunCapOf("5000"), /1 to 2000/, "the context cannot raise the line");
  assert.throws(() => dailyRunCapOf("0"), /1 to 2000/);
});

test("IAM: exactly the catalogue's models, one SSM parameter by ARN, KMS under encryption-context conditions, the seven tables, and the function itself for the replay", () => {
  const { desk } = synth();
  const statements = statementsOf(desk);
  const bedrock = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("bedrock:")));
  assert.equal(bedrock.length, 1);
  assert.deepEqual(actionsOf(bedrock[0]!).sort(), ["bedrock:Converse", "bedrock:ConverseStream", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
  const resources = JSON.stringify(bedrock[0]!.Resource);
  for (const entry of Object.values(CATALOGUE)) assert.ok(resources.includes(`foundation-model/${entry.foundationModelId}`), entry.foundationModelId);
  assert.ok(resources.includes("inference-profile/us.amazon.nova-micro-v1:0") && resources.includes("inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0"));
  assert.ok(!resources.includes("foundation-model/*") && !resources.includes('"*"'), "no wildcard model");
  const mantle = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("bedrock-mantle:")));
  assert.equal(mantle.length, 1, "the OpenAI-compatible endpoint's own action");
  assert.deepEqual(actionsOf(mantle[0]!), ["bedrock-mantle:CreateInference"]);
  assert.ok(JSON.stringify(mantle[0]!.Resource).includes(":bedrock-mantle:us-east-1:111122223333:project/default"), "the account's default Mantle project, nothing wider");
  const ssm = statements.filter((st) => actionsOf(st).includes("ssm:GetParameter"));
  assert.equal(ssm.length, 1);
  assert.ok(JSON.stringify(ssm[0]!.Resource).includes(":parameter/zudocs/dev/agent-key"), "one parameter, by ARN");
  assert.ok(!actionsOf(ssm[0]!).includes("ssm:GetParameters") && !actionsOf(ssm[0]!).includes("ssm:GetParametersByPath"));
  const kmsStatements = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("kms:")));
  assert.equal(kmsStatements.length, 2, "the store's wrap/unwrap and SSM's decrypt");
  const store = kmsStatements.find((st) => actionsOf(st).includes("kms:Encrypt"))!;
  assert.deepEqual(actionsOf(store).sort(), ["kms:Decrypt", "kms:Encrypt"]);
  assert.deepEqual(store.Condition, { StringEquals: { "kms:EncryptionContext:application": "zudocs-desk" } });
  const viaSsm = kmsStatements.find((st) => st !== store)!;
  assert.deepEqual(actionsOf(viaSsm), ["kms:Decrypt"]);
  assert.equal((viaSsm.Condition as any).StringEquals["kms:ViaService"], "ssm.us-east-1.amazonaws.com");
  assert.ok(JSON.stringify((viaSsm.Condition as any).StringEquals["kms:EncryptionContext:PARAMETER_ARN"]).includes("parameter/zudocs/dev/agent-key"));
  const dynamo = statements.filter((st) => actionsOf(st).some((a) => a.startsWith("dynamodb:")));
  assert.equal(dynamo.length, 1, "the seven tables' grants minimise to one statement");
  assert.deepEqual(actionsOf(dynamo[0]!).sort(), ["dynamodb:BatchWriteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem"]);
  const tableRefs = JSON.stringify(dynamo[0]!.Resource).match(/"[A-Za-z]+Table[A-F0-9]{8}"/g) ?? [];
  assert.equal(new Set(tableRefs).size, 8, "every table (and its indexes), no wildcard");
  const self = statements.filter((st) => actionsOf(st).includes("lambda:InvokeFunction"));
  assert.equal(self.length, 1);
  assert.ok(JSON.stringify(self[0]!.Resource).includes(":function:zudocs-desk-api"), "itself, by its fixed name");
  assert.ok(JSON.stringify(self[0]!.Resource).includes(":lambda:eu-west-1:111122223333:function:zudocs-wire"), "and the eu-west wire function, by its fixed name in the other region");
  assert.equal((JSON.stringify(self[0]!.Resource).match(/function:/g) ?? []).length, 2, "nothing else");
  const [role] = Object.values(desk.findResources("AWS::IAM::Role", { Properties: { AssumeRolePolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Principal: { Service: "lambda.amazonaws.com" } })] }) } }) as Resources);
  assert.deepEqual((role!.Properties.ManagedPolicyArns as unknown[]).length, 1, "only the basic execution policy is managed; the deny policy arrives through the budget action");
});

test("phase 6: the staging run key is a second parameter by ARN under the same key; Run Command reaches the eu-west instance by its Name tag only; the environment names the run URL and never a key", () => {
  const { desk } = synth();
  const [policy] = Object.values(desk.findResources("AWS::IAM::Policy") as Resources);
  const statements = policy!.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown; Condition?: unknown }>;
  const actionsOf = (st: { Action: string | string[] }) => (Array.isArray(st.Action) ? st.Action : [st.Action]);
  const ssm = statements.find((st) => actionsOf(st).includes("ssm:GetParameter"))!;
  const resources = JSON.stringify(ssm.Resource);
  assert.ok(resources.includes(":parameter/zudocs/dev/agent-key") && resources.includes(":parameter/zudocs/staging/run-key"), "both parameters, by ARN, nothing wider");
  assert.equal((resources.match(/:parameter\//g) ?? []).length, 2);
  const viaSsm = statements.find((st) => actionsOf(st).includes("kms:Decrypt") && !actionsOf(st).includes("kms:Encrypt"))!;
  const context = JSON.stringify((viaSsm.Condition as any).StringEquals["kms:EncryptionContext:PARAMETER_ARN"]);
  assert.ok(context.includes("parameter/zudocs/staging/run-key"), "SSM may decrypt the run key parameter for this function too");
  const sendCommand = statements.filter((st) => actionsOf(st).includes("ssm:SendCommand"));
  assert.equal(sendCommand.length, 2, "the desk's own document, and instances by tag");
  const document = sendCommand.find((st) => JSON.stringify(st.Resource).includes(`document/${HOST_CLI_DOCUMENT_NAME}`))!;
  assert.ok(document, "SendCommand is granted on the desk's own Command document");
  assert.ok(JSON.stringify(document.Resource).includes(`:ssm:eu-west-1:111122223333:document/${HOST_CLI_DOCUMENT_NAME}`), "the one document, the account's own, in the host's region");
  assert.equal(document.Condition, undefined);
  assert.ok(!JSON.stringify(document.Resource).includes("document/*"), "no wildcard document");
  const instances = sendCommand.find((st) => JSON.stringify(st.Resource).includes(":instance/"))!;
  assert.ok(JSON.stringify(instances.Resource).includes(":ec2:eu-west-1:111122223333:instance/*"));
  assert.deepEqual(instances.Condition, { StringEquals: { "ssm:resourceTag/Name": "zudocs-eu-host" } }, "only the instance that carries the host's Name tag — the desk never learns an id");
  const reads = statements.find((st) => actionsOf(st).includes("ssm:GetCommandInvocation"))!;
  assert.deepEqual(actionsOf(reads).sort(), ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]);
  assert.ok(!statements.some((st) => actionsOf(st).some((a) => /ssm:StartSession|ssm:PutParameter|ec2:/.test(a))), "no session, no parameter writes, no EC2 control");
  const [fn] = Object.values(desk.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "zudocs-desk-api" } }) as Resources);
  const env = fn!.Properties.Environment.Variables as Record<string, string>;
  assert.equal(env.RUN_KEY_PARAMETER, "/zudocs/staging/run-key", "a name, never a key");
  assert.equal(env.AIRPROMPTER_HOSTED_RUN_URL, "https://run.example");
  assert.equal(env.AIRPROMPTER_HOSTED_TARGET, "staging");
  assert.equal(env.EU_HOST_REGION, "eu-west-1");
  assert.equal(env.EU_HOST_NAME_TAG, "zudocs-eu-host");
  assert.ok(!Object.values(env).some((v) => /^apr_|^apa_/.test(v)));
  // Without a run URL in the file, the hosted variables are absent and the desk says "not configured" instead of guessing.
  const { desk: bare } = synthAll(undefined, {}, { ...IDS, hostedRunUrl: null });
  const [bareFn] = Object.values(bare.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "zudocs-desk-api" } }) as Resources);
  const bareEnv = bareFn!.Properties.Environment.Variables as Record<string, string>;
  assert.equal(bareEnv.RUN_KEY_PARAMETER, undefined);
  assert.equal(bareEnv.AIRPROMPTER_HOSTED_RUN_URL, undefined);
});

test("tables: eight, on-demand, encrypted, destroyable (demo data); the runs table has the byTicket index; events expire by TTL", () => {
  const { desk } = synth();
  const tables = Object.values(desk.findResources("AWS::DynamoDB::Table") as Resources);
  assert.equal(tables.length, 8);
  for (const t of tables) {
    assert.equal(t.Properties.BillingMode, "PAY_PER_REQUEST", t.Properties.TableName);
    assert.deepEqual(t.Properties.SSESpecification, { SSEEnabled: true }, t.Properties.TableName);
  }
  assert.deepEqual(tables.map((t) => t.Properties.TableName).sort(), ["approvals", "counters", "customers", "events", "feedback", "runs", "status", "tickets"].map((n) => `zudocs-desk-${n}`));
  desk.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "zudocs-desk-approvals", KeySchema: [{ AttributeName: "approvalId", KeyType: "HASH" }] });
  desk.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "zudocs-desk-runs", GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "byTicket" })] });
  desk.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "zudocs-desk-events", TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true } });
  desk.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  desk.hasResourceProperties("AWS::KMS::Alias", { AliasName: "alias/zudocs-desk" });
});

test("the desk app: a private bucket, GetObject-only origin, SPA fallback to 200, a CSP that connects to the API and the hosted UI only, config.json from the stack's outputs, desk.zudocs.com records", () => {
  const { desk } = synth();
  for (const [id, bucket] of Object.entries(desk.findResources("AWS::S3::Bucket") as Resources)) {
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, id);
  }
  desk.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      Aliases: ["desk.zudocs.com"],
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      CustomErrorResponses: Match.arrayWith([Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }), Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" })]),
    }),
  });
  const [headers] = Object.values(desk.findResources("AWS::CloudFront::ResponseHeadersPolicy") as Resources);
  const csp = JSON.stringify(headers!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);
  assert.ok(csp.includes("default-src 'self'; connect-src 'self' ") && csp.includes("ApiEndpoint") && csp.includes(".auth.us-east-1.amazoncognito.com"), "connect-src: the API (its endpoint attribute) and the hosted UI");
  assert.ok(csp.includes("frame-ancestors 'none'") && !csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  const deployments = Object.values(desk.findResources("Custom::CDKBucketDeployment") as Resources);
  assert.equal(deployments.length, 1);
  assert.equal((deployments[0]!.Properties.SourceObjectKeys as unknown[]).length, 2, "the built app and the generated config.json");
  assert.ok(JSON.stringify(deployments[0]!.Properties.SourceMarkers).includes("ApiEndpoint"), "config.json carries the API endpoint resolved at deploy time");
  assert.equal(Object.keys(desk.findResources("AWS::Route53::RecordSet", { Properties: { Name: "desk.zudocs.com." } })).length, 2, "A and AAAA");
});

test("the Budgets action attaches the site's deny policy to the function's role and the eu-west host's role at 100 % of zudocs-monthly, automatically; it is skipped only when the budget e-mail is waived", () => {
  const { desk, site } = synth();
  desk.hasResourceProperties("AWS::Budgets::BudgetsAction", {
    BudgetName: "zudocs-monthly",
    ActionType: "APPLY_IAM_POLICY",
    ActionThreshold: { Type: "PERCENTAGE", Value: 100 },
    NotificationType: "ACTUAL",
    ApprovalModel: "AUTOMATIC",
    Subscribers: [{ Type: "EMAIL", Address: "owner@example.test" }],
    Definition: { IamActionDefinition: Match.objectLike({ Roles: [Match.anyValue(), "zudocs-eu-host"] }) },
  });
  const [action] = Object.values(desk.findResources("AWS::Budgets::BudgetsAction") as Resources);
  assert.ok(JSON.stringify(action!.Properties.Definition.IamActionDefinition.PolicyArn).includes("ZudocsSite:ExportsOutput"), "the policy ARN comes from the site stack");
  site.hasResourceProperties("AWS::Budgets::Budget", { Budget: Match.objectLike({ BudgetName: "zudocs-monthly" }) });
  const executor = Object.values(desk.findResources("AWS::IAM::Role", { Properties: { AssumeRolePolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Principal: { Service: "budgets.amazonaws.com" } })] }) } }) as Resources);
  assert.equal(executor.length, 1, "Budgets assumes a role of its own");
  const attach = statementsOf(desk).filter((st) => actionsOf(st).includes("iam:AttachRolePolicy"));
  assert.equal(attach.length, 1);
  const attachTo = JSON.stringify(attach[0]!.Resource);
  assert.ok(!attachTo.includes('"*"'), "attach to the two model roles only");
  assert.ok(attachTo.includes(":role/zudocs-eu-host"), "the eu-west host's role by its fixed name (IAM is global)");
  const waived = synth("", { allowNoBudgetEmail: "true" });
  assert.equal(Object.keys(waived.desk.findResources("AWS::Budgets::BudgetsAction")).length, 0);
});

test("the proof client on the site: password flow only, no hosted UI, no secret", () => {
  const { site } = synth();
  site.hasResourceProperties("AWS::Cognito::UserPoolClient", { ClientName: "proof", GenerateSecret: false, ExplicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"] });
  const [proof] = Object.values(site.findResources("AWS::Cognito::UserPoolClient", { Properties: { ClientName: "proof" } }) as Resources);
  assert.ok(!("CallbackURLs" in proof!.Properties) && !("AllowedOAuthFlows" in proof!.Properties), "nothing a browser could use");
  site.hasResourceProperties("AWS::Cognito::UserPoolClient", { ClientName: "desk", ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"] });
});

test("the entry point reads the identifiers and the pinned public root from the repository, never a key", () => {
  const ids = readAirPrompterIds();
  assert.equal(ids.agentId, "agent_1QNnYql4RXq9taZn");
  assert.equal(ids.environment, "dev");
  assert.ok(!("d" in JSON.parse(ids.rootJwk)));
  assert.match(ids.edgePointerUrl ?? "", /\/g\/[A-Za-z0-9_-]+\/generation\.json$/, "the environment's pointer, an identifier the daemon idles on");
  assert.throws(() => readAirPrompterIds("/nonexistent"), /ENOENT|missing/);
});

test("phase 6 addendum: no synthesized template anywhere grants or names AWS-RunShellScript — the desk's Run Command goes through its own document only", () => {
  const { dns, site, ci, desk, sharedHost, fleet, airgap } = synth();
  for (const [name, template] of Object.entries({ dns, site, ci, desk, sharedHost, fleet, airgap })) {
    assert.ok(!JSON.stringify(template.toJSON()).includes("AWS-RunShellScript"), `${name}: AWS-RunShellScript would be arbitrary root on a host that holds the Agent key`);
  }
  const statements = statementsOf(desk);
  const sendCommand = statements.filter((st) => actionsOf(st).includes("ssm:SendCommand"));
  const documents = sendCommand.flatMap((st) => (JSON.stringify(st.Resource).match(/document\/[A-Za-z0-9_.-]+/g) ?? []));
  assert.deepEqual(documents, [`document/${HOST_CLI_DOCUMENT_NAME}`], "exactly one document ARN, the desk's own");
});
