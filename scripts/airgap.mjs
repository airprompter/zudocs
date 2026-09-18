#!/usr/bin/env node
/**
 * The air-gapped host, up and down from the owner's profile — never from CI. `up` stages what the host's first boot
 * needs in the exchange bucket's `tools/` prefix (the pinned Node tarball and the released CLI, downloaded to a cache
 * and verified against `services/airgap/pins.json` and `services/eu-host/pins.json` before they are uploaded; the
 * host verifies them again before either runs), builds the host bundle, deploys `ZudocsAirgap`, and waits for the
 * host's first status document. `down` destroys the stack (the exchange bucket keeps every artefact — the sealed
 * bundles, the status documents, the exports; the host's public key is removed, since the private half died with
 * the host) and the desk's card fades. `status` reads the stack, the host's document and the exchange's pointer.
 * `shell` prints the Instance Connect command; `run <command>` runs one command on the host through the endpoint
 * (an SSH key minted for the session, pushed with SendSSHPublicKey, the tunnel by open-tunnel) and prints its output.
 *
 * Nothing here holds a key: the host generates its own; the Agent key lives in SSM for the puller alone.
 *
 * @example
 * ```sh
 * AWS_PROFILE=zudocs npm run airgap:up                   # ~10 minutes: tools staged, stack deployed, first status document
 * AWS_PROFILE=zudocs npm run airgap:status
 * AWS_PROFILE=zudocs node scripts/airgap.mjs run 'curl -sS -m 8 -o /dev/null https://api-dev.airprompter.com/; echo exit=$?'
 * AWS_PROFILE=zudocs npm run airgap:down
 * ```
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { EC2InstanceConnectClient, SendSSHPublicKeyCommand } from "@aws-sdk/client-ec2-instance-connect";
import { repoRoot } from "./lib/config.mjs";

const region = process.env.ZUDOCS_FLEET_REGION ?? "ap-southeast-1";
const command = process.argv[2] ?? "status";
const s3 = new S3Client({ region });
const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "zudocs", "tools");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pins = JSON.parse(readFileSync(join(repoRoot, "services", "eu-host", "pins.json"), "utf8"));
const airgapPins = JSON.parse(readFileSync(join(repoRoot, "services", "airgap", "pins.json"), "utf8"));
const TOOLS = [
  { asset: airgapPins.node.asset, url: airgapPins.node.url, sha256: airgapPins.node.sha256, what: `Node ${airgapPins.node.version} (linux-arm64)` },
  { asset: pins.cli.asset, url: pins.cli.url, sha256: pins.cli.sha256, what: `the released CLI ${pins.cli.tag} (linux-arm64)` },
];

const outputsOf = async (stackName) => {
  try {
    const out = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }));
    return { status: out.Stacks[0].StackStatus, outputs: Object.fromEntries((out.Stacks[0].Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])) };
  } catch (error) {
    if (/does not exist/.test(error.message)) return null;
    throw error;
  }
};

const sha256Of = async (path) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

/** The tool in the cache, downloaded when missing, verified against the pin either way. */
async function cached(tool) {
  mkdirSync(cache, { recursive: true });
  const path = join(cache, tool.asset);
  if (!existsSync(path)) {
    console.log(`downloading ${tool.what} → ${path}`);
    const response = await fetch(tool.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`${tool.url}: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(`${path}.part`));
    const digest = await sha256Of(`${path}.part`);
    if (digest !== tool.sha256) {
      rmSync(`${path}.part`);
      throw new Error(`${tool.asset}: sha256 ${digest} does not match the pin ${tool.sha256}`);
    }
    spawnSync("mv", [`${path}.part`, path]);
  }
  const digest = await sha256Of(path);
  if (digest !== tool.sha256) throw new Error(`${path}: sha256 ${digest} does not match the pin ${tool.sha256} — delete it and run again`);
  return path;
}

/** The tool in the exchange's tools/ prefix with the pinned digest as metadata; uploaded when absent or different. */
async function staged(bucket, tool) {
  const key = `tools/${tool.asset}`;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (head.Metadata?.sha256 === tool.sha256) {
      console.log(`  ${key}: already staged (${head.ContentLength} bytes, sha256 ${tool.sha256.slice(0, 12)}…)`);
      return;
    }
  } catch (error) {
    if (!/NotFound|404/.test(String(error.name ?? error.message))) throw error;
  }
  const path = await cached(tool);
  console.log(`  uploading ${key} (${statSync(path).size} bytes)`);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(path), ContentLength: statSync(path).size, Metadata: { sha256: tool.sha256 }, ContentType: "application/octet-stream" }));
}

const cdk = (args) => {
  // A deploy and a destroy both synthesize the app, which needs the budget's recipient (as the deploy workflow sets it).
  if (!process.env.BUDGET_EMAIL) throw new Error("BUDGET_EMAIL is not set: the app's configuration needs the budget's recipient (export it as the deploy workflow does)");
  const run = spawnSync("npx", ["cdk", ...args], { cwd: join(repoRoot, "infra"), stdio: "inherit", env: process.env });
  if (run.status !== 0) throw new Error(`cdk ${args[0]} failed (exit ${run.status})`);
};

const readJson = async (bucket, key) => {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await out.Body.transformToString("utf8"));
  } catch (error) {
    if (/NoSuchKey|NotFound/.test(String(error.name))) return null;
    throw error;
  }
};

async function fleet() {
  const stack = await outputsOf("ZudocsFleet");
  if (!stack) throw new Error("ZudocsFleet is not deployed in this region; CI deploys it from main");
  return stack.outputs;
}

async function up() {
  const { ExchangeBucketName: bucket } = await fleet();
  console.log(`staging the first boot's tools in s3://${bucket}/tools/ (verified against the pins):`);
  for (const tool of TOOLS) await staged(bucket, tool);
  // The whole build: every stack on the app needs its artefact to exist before any of them synthesizes.
  console.log("building (every stack's artefact must exist for the synth)");
  const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (build.status !== 0) throw new Error("the build failed");
  console.log("deploying ZudocsAirgap (the owner's profile; never CI)");
  // --exclusively: the fleet stack is CI's; a deploy from a checkout must never redeploy it as a dependency.
  cdk(["deploy", "ZudocsAirgap", "--exclusively", "--require-approval", "never"]);
  const stack = await outputsOf("ZudocsAirgap");
  console.log(`instance ${stack.outputs.InstanceId} · endpoint ${stack.outputs.InstanceConnectEndpointId} · route table ${stack.outputs.RouteTableId} (no route out)`);
  console.log(`shell: ${stack.outputs.ShellCommand}`);
  process.stdout.write("waiting for the host's first status document (the boot takes a few minutes) ");
  for (let i = 0; i < 60; i += 1) {
    const doc = await readJson(bucket, "status/airgap.json");
    if (doc && doc.startedAt && Date.parse(doc.startedAt) > Date.now() - 20 * 60_000 && doc.ec2?.instanceId === stack.outputs.InstanceId) {
      console.log(`\nthe host is up: phase ${doc.phase}, key ${doc.keyId?.slice(0, 8)}…, sdk ${doc.sdk}, generation ${doc.status?.generation ?? "—"}`);
      console.log(`probe: ${doc.probe ? `curl exit ${doc.probe.curl.exit} (${doc.probe.curl.meaning}) · DNS ${doc.probe.dns.resolved ? "resolves" : "does not resolve"}` : "not written yet"}`);
      const key = await readJson(bucket, "keys/airgap.distribution.pub.json");
      console.log(`public key in the exchange: ${key ? `${key.kind} ${key.keyId}` : "not yet"}`);
      console.log("the puller re-seals the held generation to this key on its next tick; the host applies it within its timer (npm run airgap:status)");
      return;
    }
    process.stdout.write(".");
    await sleep(10_000);
  }
  console.log("\nno status document after ten minutes: read /var/log/zudocs-boot.log through the shell");
  process.exitCode = 1;
}

async function down() {
  const { ExchangeBucketName: bucket } = await fleet();
  const stack = await outputsOf("ZudocsAirgap");
  if (!stack) {
    console.log("ZudocsAirgap is not deployed");
  } else {
    cdk(["destroy", "ZudocsAirgap", "--exclusively", "--force"]);
  }
  // The private half died with the host; the public half would make the puller seal to a key nobody holds.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "keys/airgap.distribution.pub.json" }));
  console.log(`down. s3://${bucket} keeps the sealed bundles, the status documents and the exports; keys/airgap.distribution.pub.json removed (the bucket is versioned: the old public half is a noncurrent version). The desk's card fades after fifteen minutes; the puller writes plaintext (dev) bundles until the next host publishes a key.`);
}

async function status() {
  const { ExchangeBucketName: bucket, PullerFunctionName } = await fleet();
  const stack = await outputsOf("ZudocsAirgap");
  console.log(`ZudocsAirgap: ${stack ? `${stack.status} · instance ${stack.outputs.InstanceId}` : "not deployed"}`);
  const latest = await readJson(bucket, "latest.json");
  console.log(`exchange latest.json: ${latest ? `generation ${latest.generation} · ${latest.keyId ? `sealed to ${latest.keyId.slice(0, 8)}…` : "plaintext (dev)"} · ${latest.object} · pulled ${latest.pulledAt}` : "none (the puller has not pulled; is the SSM parameter written in this region?)"}`);
  const key = await readJson(bucket, "keys/airgap.distribution.pub.json");
  console.log(`public key: ${key ? `${key.keyId} (${key.createdAt})` : "none"}`);
  const doc = await readJson(bucket, "status/airgap.json");
  if (!doc) {
    console.log("status/airgap.json: none");
    return;
  }
  const age = Math.round((Date.now() - Date.parse(doc.writtenAt)) / 1000);
  console.log(`status/airgap.json: written ${age}s ago (seq ${doc.seq}) · instance ${doc.ec2?.instanceId ?? "—"} · phase ${doc.phase} · key ${doc.keyId?.slice(0, 8) ?? "—"}… · sdk ${doc.sdk}`);
  console.log(`  release #${doc.status?.generation ?? "—"} ${doc.status?.applyState ?? ""} · source ${doc.status?.source ?? "—"} · ${doc.status?.storageProtection ?? "—"} · healthz ${doc.healthz?.status ?? doc.phase}${doc.healthz?.reasons?.length ? ` (${doc.healthz.reasons.join(", ")})` : ""}`);
  console.log(`  applies: ${doc.applies.map((a) => `#${a.generation ?? "—"} ${a.outcome}${a.reason ? ` (${a.reason})` : ""} from ${a.source} at ${a.at}`).join(" · ") || "none"}`);
  console.log(`  renders: ${doc.renders.count} (refused: no model here)${doc.renders.last ? ` · last ${doc.renders.last.versionId} on ${doc.renders.last.model} arm ${doc.renders.last.arm}` : ""}`);
  console.log(`  export: ${doc.export ? `${doc.export.segments} segments at ${doc.export.at}${doc.export.object ? ` → ${doc.export.object}` : ""}` : "none yet"}`);
  console.log(`  probe: ${doc.probe ? `curl ${doc.probe.curl.url} exit ${doc.probe.curl.exit} in ${doc.probe.curl.seconds}s (${doc.probe.curl.meaning}); DNS ${doc.probe.dns.name} ${doc.probe.dns.detail}` : "none"}`);
  if (doc.waitingFor?.newest) console.log(`  waiting: the exchange holds #${doc.waitingFor.newest.generation} ${doc.waitingFor.newest.keyId ? `sealed to ${doc.waitingFor.newest.keyId.slice(0, 8)}…` : "plaintext"}; the puller (${PullerFunctionName}) re-seals on its next tick`);
}

/** One command on the host: a session key, pushed through the API; ssh through the endpoint's tunnel. */
async function run(remote) {
  const stack = await outputsOf("ZudocsAirgap");
  if (!stack) throw new Error("ZudocsAirgap is not deployed");
  const instanceId = stack.outputs.InstanceId;
  const dir = mkdtempSync(join(tmpdir(), "zudocs-airgap-"));
  try {
    const keyPath = join(dir, "session");
    const gen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "zudocs-airgap-session"], { stdio: "inherit" });
    if (gen.status !== 0) throw new Error("ssh-keygen failed");
    await new EC2InstanceConnectClient({ region }).send(new SendSSHPublicKeyCommand({ InstanceId: instanceId, InstanceOSUser: "ec2-user", SSHPublicKey: readFileSync(`${keyPath}.pub`, "utf8") }));
    const proxy = `aws ec2-instance-connect open-tunnel --region ${region} --instance-id ${instanceId}`;
    const ssh = spawnSync("ssh", ["-o", `ProxyCommand=${proxy}`, "-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`, "-o", "LogLevel=ERROR", "-i", keyPath, `ec2-user@${instanceId}`, remote], { encoding: "utf8", env: process.env, timeout: 120_000 });
    process.stdout.write(ssh.stdout ?? "");
    if (ssh.stderr) process.stderr.write(ssh.stderr);
    process.exitCode = ssh.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  switch (command) {
    case "up": await up(); break;
    case "down": await down(); break;
    case "status": await status(); break;
    case "shell": console.log((await outputsOf("ZudocsAirgap"))?.outputs.ShellCommand ?? "ZudocsAirgap is not deployed"); break;
    case "run": {
      const remote = process.argv.slice(3).join(" ");
      if (!remote) throw new Error("usage: airgap.mjs run '<command>'");
      await run(remote);
      break;
    }
    default: throw new Error("usage: airgap.mjs up | down | status | shell | run '<command>'");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
