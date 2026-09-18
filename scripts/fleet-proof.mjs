#!/usr/bin/env node
/**
 * The ap-southeast-1 fleet, proved from the owner's session: the puller's row in the status table says what the
 * plan promised (a generation in the exchange, its pulls pointer-first — the log's idle ticks are CDN reads, the
 * origin at most once an hour by the stuck-pointer bound), the releases table's newest row names an object that
 * exists and `latest.json` agrees; with the flags: a nudge from the desk reaches the puller within a minute and it
 * pulls with `skipPointer`; the air-gapped host's row is fresh, serves the exchange's generation, carries the key
 * born on it (the public half in the bucket, no private member), its probe says no route out — and, through the
 * Instance Connect Endpoint, a live `curl` from the host times out, the route table has no default route, the
 * private key is 0600; the eu-west import timer has imported the host's exports. Prints ids, counts and verdicts;
 * never a key. Exit 1 when a claim fails.
 *
 * @example
 * ```sh
 * export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'     # the proof user's password, from the owner's store
 * npm run fleet:proof                                     # the puller: row, table, bucket, pointer reads in the log
 * npm run fleet:proof -- --nudge                          # nudge from the desk → the puller reads the origin
 * npm run fleet:proof -- --airgap                         # the air-gapped host: row, key, probe, a live shell probe
 * npm run fleet:proof -- --wait-generation 4              # a promotion reached the exchange and the air-gapped host
 * npm run fleet:proof -- --import                         # exports in the bucket, imported by eu-west
 * ```
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeRouteTablesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { repoRoot, secretFromEnv } from "./lib/config.mjs";

const siteRegion = process.env.AWS_REGION ?? "us-east-1";
const fleetRegion = process.env.ZUDOCS_FLEET_REGION ?? "ap-southeast-1";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const proofEmail = process.env.ZUDOCS_PROOF_EMAIL ?? "proof@zudocs.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (iso) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 1000)}s ago` : "never");

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures += 1; console.log(`  ✗ ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));

let password;
try {
  password = secretFromEnv("ZUDOCS_PROOF_PASSWORD", "the proof user's password (scripts/cognito-users.sh proof)");
} catch (error) {
  console.log(error.message);
  process.exit(2);
}

const outputsOf = async (region, stackName) => {
  try {
    return Object.fromEntries((await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }))).Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]));
  } catch (error) {
    if (/does not exist/.test(error.message)) return null;
    throw error;
  }
};
const site = await outputsOf(siteRegion, "ZudocsSite");
const desk = await outputsOf(siteRegion, "ZudocsDesk");
const fleet = await outputsOf(fleetRegion, "ZudocsFleet");
const airgapStack = await outputsOf(fleetRegion, "ZudocsAirgap");
if (!fleet) { console.log("ZudocsFleet is not deployed"); process.exit(1); }
console.log(`stacks: api ${desk.ApiUrl} · exchange s3://${fleet.ExchangeBucketName} · table ${fleet.ReleasesTableName} · puller ${fleet.PullerFunctionName} (every ${fleet.PullMinutes} min) · queue ${fleet.NudgeQueueUrl.split("/").pop()} · airgap ${airgapStack ? airgapStack.InstanceId : "not deployed"}`);

const cognito = new CognitoIdentityProviderClient({ region: siteRegion });
const auth = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: site.UserPoolId, ClientId: site.ProofClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: proofEmail, PASSWORD: password } }));
const idToken = auth.AuthenticationResult?.IdToken;
if (!idToken) { console.log(`sign-in as ${proofEmail} did not yield tokens (challenge: ${auth.ChallengeName ?? "none"})`); process.exit(1); }
const api = async (method, path, body) => {
  const response = await fetch(`${desk.ApiUrl}${path}`, { method, headers: { authorization: `Bearer ${idToken}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const hostRow = async (hostId) => (await api("GET", "/state")).json.hosts?.find((h) => h.hostId === hostId) ?? null;
const eventsSince = async (since) => (await api("GET", `/events?since=${encodeURIComponent(since)}`)).json.events ?? [];

const s3 = new S3Client({ region: fleetRegion });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: fleetRegion }));
const logsClient = new CloudWatchLogsClient({ region: fleetRegion });
const readJson = async (key) => {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: fleet.ExchangeBucketName, Key: key }));
    return JSON.parse(await out.Body.transformToString("utf8"));
  } catch (error) {
    if (/NoSuchKey|NotFound/.test(String(error.name))) return null;
    throw error;
  }
};
const exists = async (key) => {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: fleet.ExchangeBucketName, Key: key }));
    return { exists: true, bytes: head.ContentLength, metadata: head.Metadata ?? {} };
  } catch (error) {
    if (/NotFound|404/.test(String(error.name ?? error.message))) return { exists: false };
    throw error;
  }
};
const newestRow = async () => {
  const state = (await api("GET", "/state")).json;
  const scope = `release#${state.airprompter.agentId}/${state.airprompter.environment}`;
  const out = await ddb.send(new QueryCommand({ TableName: fleet.ReleasesTableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": scope }, ScanIndexForward: false, Limit: 1, ConsistentRead: true }));
  return out.Items?.[0] ?? null;
};
const pullerLog = async (sinceMs, pattern) => {
  const events = [];
  let token;
  do {
    const page = await logsClient.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${fleet.PullerFunctionName}`, startTime: Date.now() - sinceMs, filterPattern: pattern, nextToken: token, limit: 200 }));
    events.push(...(page.events ?? []));
    token = page.nextToken;
  } while (token);
  return events.map((e) => { try { return JSON.parse(e.message.replace(/^\S+\s+\S+\s+\S+\s+/, "")); } catch { return null; } }).filter(Boolean);
};

// --- (a) the puller ------------------------------------------------------------------------------------------------------
console.log("\nthe puller");
const puller = await hostRow(fleet.PullerHostId);
check(puller && puller.kind === "puller", `row ${fleet.PullerHostId} is a puller row`);
if (puller) {
  const s = puller.status ?? {};
  check(Date.now() - Date.parse(puller.writtenAt) < 15 * 60_000, `written ${ago(puller.writtenAt)} (within the schedule)`);
  check(puller.healthz?.status === "ok", `healthz ${puller.healthz?.status}${puller.healthz?.reasons?.length ? ` (${puller.healthz.reasons.join(", ")})` : ""}`);
  check(s.generation >= 1, `the exchange holds generation ${s.generation} (${s.keyId ? `sealed to ${String(s.keyId).slice(0, 8)}…` : "plaintext, dev"}), pulled ${ago(s.pulledAt)}`);
  check(s.edge?.pointerKnown === true, `the edge pointer is known: idle checks go to the CDN (last origin read ${ago(s.edge?.lastOriginAt)})`);
  console.log(`  this hour: ${s.reads?.pointer ?? 0} CDN reads, ${s.reads?.origin ?? 0} API reads · last pull ${s.lastPull?.outcome}${s.lastPull?.via ? ` via ${s.lastPull.via}` : ""} (${s.lastPull?.trigger}) ${ago(s.lastPull?.at)} · nudges ${s.nudges ?? 0} · streak ${s.unchangedStreak}`);
  const row = await newestRow();
  check(row && row.generation === s.generation, `the releases table's newest row is generation ${row?.generation} (digest ${String(row?.releaseDigest ?? "").slice(0, 19)}…, via ${row?.via})`);
  if (row) {
    const object = await exists(row.object);
    check(object.exists, `the bundle object ${row.object} exists (${object.bytes} bytes; metadata generation ${object.metadata?.generation}, keyid ${object.metadata?.keyid})`);
    const latest = await readJson("latest.json");
    check(latest && latest.generation === row.generation && latest.object === row.object, `latest.json points at generation ${latest?.generation}, ${latest?.object}`);
  }
  const unchanged = await pullerLog(2 * 3_600_000, '{ $.event = "unchanged" }');
  const viaPointer = unchanged.filter((e) => e.via === "pointer").length;
  const viaOrigin = unchanged.filter((e) => e.via === "origin").length;
  const pulled = await pullerLog(2 * 3_600_000, '{ $.event = "bundle_pulled" }');
  console.log(`  log, last two hours: ${unchanged.length} unchanged (${viaPointer} via the pointer — CDN 304s; ${viaOrigin} via the origin — API 304s), ${pulled.length} pulled (${pulled.map((e) => `#${e.generation} ${e.trigger}`).join(", ") || "none"})`);
  check(unchanged.length === 0 || viaPointer > 0, "idle ticks read the pointer, not the origin");
  check(viaOrigin <= 2 + pulled.length, `origin reads are bounded (one per hour by the stuck-pointer bound, plus one per pull)`);
}

// --- (b) the nudge ----------------------------------------------------------------------------------------------------
if (flag("--nudge")) {
  console.log("\nthe nudge");
  const since = new Date(Date.now() - 5_000).toISOString();
  const before = (await hostRow(fleet.PullerHostId))?.status?.nudges ?? 0;
  const posted = await api("POST", "/presenter/nudge", {});
  check(posted.status === 202 && posted.json.messageId, `POST /presenter/nudge → ${posted.status} (message ${posted.json.messageId ?? "none"}): ${posted.json.message ?? posted.json.error}`);
  let nudged = null;
  for (let i = 0; i < 18 && !nudged; i += 1) {
    await sleep(5_000);
    nudged = (await eventsSince(since)).find((e) => e.kind === "nudged");
  }
  check(nudged, `the puller wrote \`nudged\` ${nudged ? `${Math.round((Date.parse(nudged.at) - Date.parse(since)) / 1000)} s after the post (by ${nudged.by})` : "within 90 s"}`);
  await sleep(5_000);
  const after = await hostRow(fleet.PullerHostId);
  check((after?.status?.nudges ?? 0) > before, `nudges ${before} → ${after?.status?.nudges}`);
  check(after?.status?.lastPull?.trigger === "nudge", `the last pull's trigger is \`nudge\` (${after?.status?.lastPull?.outcome}${after?.status?.lastPull?.via ? ` via ${after.status.lastPull.via}` : ""})`);
  const logged = await pullerLog(5 * 60_000, '{ $.event = "nudged" }');
  check(logged.length > 0, `the log carries the nudge (${logged.length} in five minutes)`);
  const skip = (await pullerLog(5 * 60_000, '{ $.trigger = "nudge" }')).find((e) => e.event === "unchanged" || e.event === "bundle_pulled");
  check(skip && (skip.event === "bundle_pulled" || skip.via === "origin"), `the nudged pull skipped the pointer and read the origin (${skip?.event}${skip?.via ? ` via ${skip.via}` : ""})`);
}

// --- (c) the air-gapped host ------------------------------------------------------------------------------------------
if (flag("--airgap")) {
  console.log("\nthe air-gapped host");
  check(airgapStack, "ZudocsAirgap is deployed");
  const row = await hostRow(fleet.AirgapHostId);
  check(row && row.kind === "airgapped", `row ${fleet.AirgapHostId} is an air-gapped row`);
  if (row) {
    const a = row.airgap ?? {};
    check(Date.now() - Date.parse(row.writtenAt) < 6 * 60_000, `the host wrote its document ${ago(row.writtenAt)} (mirrored ${ago(row.mirroredAt)})`);
    check(row.ec2?.instanceId === airgapStack?.InstanceId, `the document is this instance's (${row.ec2?.instanceId})`);
    check(a.keyId && a.keyPublished, `distribution key ${String(a.keyId ?? "").slice(0, 8)}… born on the host; the public half is in the exchange`);
    const pub = await readJson("keys/airgap.distribution.pub.json");
    check(pub && pub.kind === "airprompter-distribution-public-key" && pub.keyId === a.keyId && pub.privateKey === undefined, `keys/airgap.distribution.pub.json is the public half only (kind ${pub?.kind}, no private member)`);
    check(a.probe && a.probe.curl.exit !== 0, `the boot probe: curl ${a.probe?.curl.url} exit ${a.probe?.curl.exit} in ${a.probe?.curl.seconds}s — ${a.probe?.curl.meaning}; DNS ${a.probe?.dns.detail}`);
    const exchange = (await hostRow(fleet.PullerHostId))?.status;
    check(row.status?.generation && row.status.generation === exchange?.generation, `serving generation ${row.status?.generation} (${row.status?.applyState}, source ${row.status?.source}) — the exchange holds ${exchange?.generation}`);
    check(row.status?.storageProtection === "file_key", `store key ${row.status?.storageProtection} (shown, never hidden)`);
    console.log(`  applies: ${(a.applies ?? []).map((x) => `#${x.generation} ${x.outcome} from ${x.source}`).join(" · ") || "none"} · renders ${a.renders?.count ?? 0} (refused: no model) · export ${a.export ? `${a.export.segments} segments ${ago(a.export.at)}` : "none yet"}`);
    check(row.healthz?.status === "ok", `healthz ${row.healthz?.status}${row.healthz?.reasons?.length ? ` (${row.healthz.reasons.join(", ")})` : ""}`);
  }
  if (airgapStack) {
    const tables = await new EC2Client({ region: fleetRegion }).send(new DescribeRouteTablesCommand({ RouteTableIds: [airgapStack.RouteTableId] }));
    const routes = tables.RouteTables?.[0]?.Routes ?? [];
    const describe = (r) => `${r.DestinationCidrBlock ?? r.DestinationPrefixListId ?? "?"} → ${r.GatewayId ?? r.NatGatewayId ?? r.InstanceId ?? "?"}`;
    console.log(`  VPC route table ${airgapStack.RouteTableId}: ${routes.map(describe).join(" · ")}`);
    check(!routes.some((r) => r.DestinationCidrBlock === "0.0.0.0/0" || r.DestinationIpv6CidrBlock === "::/0" || r.NatGatewayId), "the VPC route table has no default route and no NAT");
    check(routes.filter((r) => r.DestinationPrefixListId && /^vpce-/.test(String(r.GatewayId))).length === 2, "two gateway-endpoint prefix-list routes (S3, DynamoDB) beside the local route");
    console.log("  through the Instance Connect Endpoint (a session key, pushed for sixty seconds):");
    const run = (remote) => spawnSync("node", [join(repoRoot, "scripts", "airgap.mjs"), "run", remote], { encoding: "utf8", env: process.env, timeout: 180_000 });
    const probe = run("curl -sS -m 8 -o /dev/null https://api-dev.airprompter.com/ 2>&1; echo curl_exit=$?; getent hosts api-dev.airprompter.com | sed 's/^/dns: /'; sudo stat -c 'key: %a %U %n' /var/lib/airprompter/keys/airgap.key.json; sudo stat -c 'pub: %a %U %n' /var/lib/airprompter/keys/airgap.pub.json; systemctl is-active zudocs-airgap zudocs-airgap-export.timer | tr '\\n' ' '; echo; /usr/local/bin/airprompter --version; /usr/local/bin/node --version");
    const out = probe.stdout ?? "";
    for (const line of out.trim().split("\n")) console.log(`    ${line}`);
    // curl 28 is a connect timeout: the VPC router black-holes the SYN (the OS has a default route from DHCP, the VPC has none).
    check(/curl_exit=(28|7|6)/.test(out), "a live curl from the host to the API host fails (no route out)");
    check(/key: 600 airprompter/.test(out), "the private key is 0600, the runtime user's");
    check(/pub: 644 airprompter/.test(out), "the public half is world-readable (it is public)");
    if (probe.status !== 0 && !out.includes("curl_exit")) fail(`the shell probe did not run: ${(probe.stderr ?? "").trim().slice(0, 300)}`);
  }
}

// --- (d) a promotion reaching the exchange and the host ------------------------------------------------------------
const waitFor = value("--wait-generation");
if (waitFor) {
  const target = Number(waitFor);
  console.log(`\nwaiting for generation ${target}`);
  const startedAt = Date.now();
  let seenPuller = null;
  let seenAirgap = null;
  for (let i = 0; i < 90 && !(seenPuller && (seenAirgap || !airgapStack)); i += 1) {
    const p = await hostRow(fleet.PullerHostId);
    if (!seenPuller && (p?.status?.generation ?? 0) >= target) seenPuller = { at: p.status.pulledAt, keyId: p.status.keyId };
    const g = await hostRow(fleet.AirgapHostId);
    if (!seenAirgap && (g?.status?.generation ?? 0) >= target) seenAirgap = { at: g.writtenAt, applies: g.airgap?.applies ?? [] };
    if (!(seenPuller && (seenAirgap || !airgapStack))) await sleep(10_000);
  }
  check(seenPuller, `the puller wrote generation ${target} ${seenPuller ? `(pulled ${seenPuller.at}, ${seenPuller.keyId ? `sealed to ${String(seenPuller.keyId).slice(0, 8)}…` : "plaintext"})` : "within fifteen minutes"}`);
  if (airgapStack) {
    const apply = seenAirgap?.applies.find((x) => x.generation === target);
    check(seenAirgap, `the air-gapped host applied generation ${target} ${seenAirgap ? `(${apply?.outcome ?? "?"} from ${apply?.source ?? "?"} at ${apply?.at ?? "?"}; document written ${seenAirgap.at})` : "within fifteen minutes"}`);
  }
  console.log(`  ${Math.round((Date.now() - startedAt) / 1000)} s`);
}

// --- (e) exports and the import -----------------------------------------------------------------------------------------
if (flag("--import")) {
  console.log("\nexports and the import");
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: fleet.ExchangeBucketName, Prefix: "telemetry/" }));
  const exports = (listed.Contents ?? []).filter((o) => o.Key.endsWith(".aptelemetry"));
  check(exports.length > 0, `${exports.length} export(s) in telemetry/ (newest ${exports.at(-1)?.Key ?? "—"}, ${exports.at(-1)?.Size ?? 0} bytes)`);
  const eu = await hostRow("eu-west-1/ec2");
  const imports = eu?.imports;
  check(imports, `the eu-west row carries the import timer's part: ${imports ? `${imports.objects} objects, ${imports.pending} pending, last pass ${ago(imports.lastPassAt)}` : "missing"}`);
  const events = await eventsSince(new Date(Date.now() - 6 * 3_600_000).toISOString());
  const imported = events.filter((e) => e.kind === "telemetry_imported");
  const done = imported.filter((e) => e.outcome === "imported");
  check(done.length > 0, `${imported.length} telemetry_imported row(s) today, ${done.length} imported (last: ${done.at(-1) ? `${done.at(-1).uploaded}/${done.at(-1).segments} segments for ${(done.at(-1).instances ?? []).length} instance(s), ${done.at(-1).object}` : "none"})`);
  const exported = events.filter((e) => e.kind === "telemetry_exported");
  check(exported.length > 0, `${exported.length} telemetry_exported row(s) mirrored from the host's document`);
}

console.log(failures === 0 ? "\nall claims hold" : `\n${failures} claim(s) failed`);
process.exit(failures === 0 ? 0 : 1);
