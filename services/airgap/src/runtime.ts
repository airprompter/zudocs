/**
 * The air-gapped runtime: the Agent SDK **offline** on a host with no route out. It holds no Agent key and never
 * calls home; what it has is the exchange bucket and the releases table through the VPC's gateway endpoints, and
 * a distribution keypair `airprompter keygen` generated on this host at first boot (the private half at 0600 here,
 * the public half in the exchange). In the order a fresh host needs:
 *
 * - **the key**: the private half is loaded (its mode checked) and its id is what the puller must seal to.
 * - **the newest row**: every `ZUDOCS_APPLY_INTERVAL_SECONDS` the releases table's newest generation. A row sealed
 *   to another key (the puller has not re-sealed yet) is waited on and said so; a row above what this host holds is
 *   fetched from the exchange and handed to the SDK — the first as the **vendored bundle** `AirPrompterAgent.start`
 *   boots on (`sync: "offline"`), every later one to `applyBundle()`; each outcome is the SDK's own and is recorded.
 *   A bundle the SDK could not start on is recorded (`startFailure`) and tried again after a cooldown, or as soon as
 *   a newer row appears — never silently given up. The vendored file is refreshed with every activation, so a restart
 *   boots on the newest and the floor is never stale.
 * - **renders**: every `ZUDOCS_RENDER_INTERVAL_SECONDS` one render of `support.triage` for a seeded customer id — the
 *   release resolves (version, arm, model) exactly as on every other host — and the observation filed is `refused`:
 *   this host has no route to any model and says so; it never invents an answer. The SDK writes the windows to its
 *   spool; the export timer carries them to the exchange.
 * - **status**: every `ZUDOCS_STATUS_INTERVAL_SECONDS` the document (`status.ts`) to `status/airgap.json`.
 *
 * The loop is built over ports (`createRuntime`) so a test drives it with fakes; `main` wires the real ones.
 * Logs are JSON lines with generations, outcomes and ids — never a render, never a key.
 *
 * @example
 * ```sh
 * # as the airprompter user, with /etc/airprompter/zudocs.env in the environment (systemd: zudocs-airgap.service)
 * node /opt/zudocs/runtime.mjs
 * ```
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AirPrompterAgent, SDK_NAME, SDK_VERSION, distributionKeyId, isAgentStartError, x25519PrivateKeyFromRaw, type AgentStatus, type BundleOutcome, type DistributionKey, type Healthz, type Observation } from "@airprompter/agent-sdk";
import { SEED_CUSTOMERS } from "../../desk-api/src/seedData.js";
import { readAirgapEnv, type AirgapEnv } from "./env.js";
import { buildStatusDoc, type AirgapPhase, type AirgapStatusDoc, type ApplyRecord, type ExportInfo, type ProbeInfo, type RenderInfo, type StartFailure } from "./status.js";

const RUNTIME_VERSION = "0.1.0";
/** The slot the render probe resolves and the end-user text it is given — a fixed sentence, never a ticket. */
export const PROBE_TAG = "support.triage";
export const PROBE_TICKET = "[render-only probe: this host has no route to a model and runs no ticket]";
/** A bundle the SDK could not start on is not re-fetched for this long, unless a newer row appears. */
export const START_RETRY_MS = 10 * 60_000;
const STATUS_KEY = "status/airgap.json";
const recent: Array<Record<string, unknown>> = [];
const log = (event: Record<string, unknown>) => {
  const line = { at: new Date().toISOString(), source: "zudocs-airgap", ...event };
  recent.push(line);
  if (recent.length > 30) recent.shift();
  process.stdout.write(JSON.stringify(line) + "\n");
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The distribution private key as `airprompter keygen` wrote it, refused when readable by anyone else. Pure over the file's text and mode. */
export function parseDistributionKeyFile(text: string, mode: number): { key: DistributionKey; keyId: string } {
  if ((mode & 0o077) !== 0) throw new Error(`the distribution private key is readable by others (mode ${(mode & 0o777).toString(8)}); it must be 0600`);
  const file = JSON.parse(text) as { kind?: unknown; publicKey?: unknown; privateKey?: unknown; keyId?: unknown };
  if (file.kind !== "airprompter-distribution-key" || typeof file.publicKey !== "string" || typeof file.privateKey !== "string") throw new Error("not a distribution private key file (kind airprompter-distribution-key)");
  const publicRaw = Buffer.from(file.publicKey, "base64url");
  const privateRaw = Buffer.from(file.privateKey, "base64url");
  if (publicRaw.length !== 32 || privateRaw.length !== 32) throw new Error("malformed key material");
  const keyId = distributionKeyId(publicRaw);
  if (typeof file.keyId === "string" && file.keyId !== keyId) throw new Error("keyId does not match the public key");
  return { key: { privateKey: x25519PrivateKeyFromRaw(privateRaw, publicRaw), publicRaw }, keyId };
}

export interface NewestRow {
  generation: number;
  releaseDigest: string;
  keyId: string | null;
  object: string;
  pulledAt: string;
}

/** What to do with the table's newest row, given this host's key, what it last handed to the SDK, and a start that failed. Pure. */
export function decideApply(input: { newest: NewestRow | null; keyId: string; attempted: number; startFailure: StartFailure | null; now: string }): { action: "nothing" | "wait_for_reseal" | "apply"; reason: string } {
  const { newest } = input;
  if (!newest) return { action: "nothing", reason: "the table holds no release yet" };
  if (newest.keyId !== input.keyId) return { action: "wait_for_reseal", reason: `generation ${newest.generation} is ${newest.keyId ? `sealed to key ${newest.keyId.slice(0, 8)}…` : "plaintext"}; this host's key is ${input.keyId.slice(0, 8)}… — waiting for the puller to seal to it` };
  if (newest.generation <= input.attempted) return { action: "nothing", reason: `generation ${newest.generation} was already handed to the SDK` };
  const failed = input.startFailure;
  if (failed && failed.releaseDigest === newest.releaseDigest && Date.parse(input.now) - Date.parse(failed.at) < START_RETRY_MS) return { action: "nothing", reason: `generation ${newest.generation} could not start the SDK at ${failed.at} (${failed.code ?? "error"}); retried after the cooldown or a newer row` };
  return { action: "apply", reason: `generation ${newest.generation} is above ${input.attempted}` };
}

/** The instance id and zone from IMDSv2 (link-local, reachable without a route); null when it does not answer. */
export async function readEc2Identity(fetchImpl: typeof fetch = fetch): Promise<{ instanceId: string; availabilityZone: string } | null> {
  try {
    const token = await fetchImpl("http://169.254.169.254/latest/api/token", { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" }, signal: AbortSignal.timeout(1500) });
    if (!token.ok) return null;
    const t = await token.text();
    const doc = await fetchImpl("http://169.254.169.254/latest/dynamic/instance-identity/document", { headers: { "X-aws-ec2-metadata-token": t }, signal: AbortSignal.timeout(1500) });
    if (!doc.ok) return null;
    const parsed = (await doc.json()) as { instanceId?: string; availabilityZone?: string };
    return parsed.instanceId && parsed.availabilityZone ? { instanceId: parsed.instanceId, availabilityZone: parsed.availabilityZone } : null;
  } catch {
    return null;
  }
}

/** A small JSON file the host's other units write (the export timer's last result, the boot probe); null when absent or malformed. */
export function readJsonFile<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

/** The vendored file, replaced atomically so a restart never reads a half-written bundle. */
export function writeVendoredFile(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** What the loop needs of the SDK: the part of `AirPrompterAgent` it calls (a fake in a test). */
export interface Agent {
  readonly generation: number;
  readonly instanceId: string;
  status(): AgentStatus;
  healthz(): Healthz;
  applyBundle(text: string): Promise<BundleOutcome>;
  prompt(tag: string, options: { subject?: string }): { renderAsync(values: Record<string, string>): Promise<{ tag: string; versionId: string; arm: string; model: string; text: string }> };
  report(observation: Observation): void;
  stop(): Promise<void>;
}

export interface RuntimePorts {
  hostId: string;
  region: string;
  keyId: string;
  sdk: string;
  ec2: { instanceId: string; availabilityZone: string } | null;
  newestRow(): Promise<NewestRow | null>;
  fetchBundle(object: string): Promise<string>;
  /** Start the SDK on the vendored file (when it exists) and the store; null when it could not (logged with the SDK's code). */
  start(): Promise<{ agent: Agent } | { agent: null; code: string | null; message: string }>;
  writeVendored(text: string): void;
  putStatus(doc: AirgapStatusDoc): Promise<void>;
  readExport(): ExportInfo | null;
  readProbe(): ProbeInfo | null;
  now(): string;
  log(event: Record<string, unknown>): void;
  recentLog(): Array<Record<string, unknown>>;
  /** What the SDK's logger said about the vendored bundle since the last start (the outcome `start()` does not return). */
  takeVendoredOutcomes(): ApplyRecord[];
}

export interface Runtime {
  applyTick(): Promise<void>;
  renderTick(): Promise<void>;
  writeStatus(): Promise<void>;
  stop(signal: string): Promise<void>;
  readonly agent: Agent | null;
  readonly attempted: number;
  readonly phase: AirgapPhase;
  readonly applies: ApplyRecord[];
  readonly renders: RenderInfo;
  readonly startFailure: StartFailure | null;
}

/** The loop over its ports. `boot()` is the first thing to call: a store from an earlier run starts without the table. */
export function createRuntime(p: RuntimePorts): Runtime & { boot(): Promise<void> } {
  const startedAt = p.now();
  const applies: ApplyRecord[] = [];
  const renders: RenderInfo = { count: 0, lastAt: null, last: null, observation: "refused" };
  let agent: Agent | null = null;
  let phase: AirgapPhase = "awaiting_bundle";
  let waitingFor: { newest: { generation: number; keyId: string | null } | null } | null = null;
  let attempted = 0;
  let startFailure: StartFailure | null = null;
  let seq = 0;
  let lastWait: string | null = null;
  let applying = false;
  const subjects = SEED_CUSTOMERS.map((c) => c.customerId);
  let cursor = 0;

  const record = (entry: ApplyRecord): void => {
    applies.push(entry);
    if (applies.length > 50) applies.shift();
  };
  const startAgent = async (row: NewestRow | null): Promise<boolean> => {
    const started = await p.start();
    for (const outcome of p.takeVendoredOutcomes()) record(outcome);
    if (started.agent) {
      agent = started.agent;
      attempted = Math.max(attempted, agent.generation, row?.generation ?? 0);
      phase = agent.generation > 0 ? "serving" : "awaiting_bundle";
      startFailure = null;
      p.log({ event: "sdk_started", instanceId: agent.instanceId, generation: agent.generation, source: agent.status().source, storageProtection: agent.status().storageProtection, syncMode: "offline" });
      return true;
    }
    if (row) {
      // Not `attempted`: the row is tried again after the cooldown, or the moment a newer one appears.
      startFailure = { at: p.now(), generation: row.generation, releaseDigest: row.releaseDigest, code: started.code, message: started.message.slice(0, 300) };
      p.log({ event: "sdk_not_started", generation: row.generation, code: started.code, message: started.message.slice(0, 300), retryAfterMs: START_RETRY_MS });
    } else {
      // At boot with no store and no vendored file this is the expected answer: the first bundle from the table starts it.
      p.log({ event: "sdk_not_started", boot: true, code: started.code, message: started.message.slice(0, 300) });
    }
    return false;
  };

  const writeStatus = async (): Promise<void> => {
    seq += 1;
    const doc = buildStatusDoc({
      hostId: p.hostId,
      region: p.region,
      sdk: p.sdk,
      startedAt,
      now: p.now(),
      seq,
      ec2: p.ec2,
      keyId: p.keyId,
      phase: agent && agent.generation > 0 ? "serving" : phase,
      waitingFor,
      status: agent?.status() ?? null,
      healthz: agent?.healthz() ?? null,
      applies,
      startFailure,
      renders,
      export: p.readExport(),
      probe: p.readProbe(),
      log: p.recentLog(),
    });
    try {
      await p.putStatus(doc);
    } catch (error) {
      p.log({ event: "status_write_failed", message: (error as Error).message.slice(0, 200) });
    }
  };

  const applyTick = async (): Promise<void> => {
    if (applying) return;
    applying = true;
    try {
      const newest = await p.newestRow();
      const decision = decideApply({ newest, keyId: p.keyId, attempted, startFailure, now: p.now() });
      waitingFor = decision.action === "wait_for_reseal" && newest ? { newest: { generation: newest.generation, keyId: newest.keyId } } : null;
      if (decision.action === "wait_for_reseal") {
        if (lastWait !== decision.reason) p.log({ event: "waiting_for_reseal", newest: newest?.generation ?? null, sealedTo: newest?.keyId ?? null, keyId: p.keyId });
        lastWait = decision.reason;
        return;
      }
      lastWait = null;
      if (decision.action !== "apply" || !newest) return;
      const text = await p.fetchBundle(newest.object);
      if (!agent) {
        p.writeVendored(text);
        p.log({ event: "vendored_bundle_written", generation: newest.generation, object: newest.object, bytes: Buffer.byteLength(text) });
        await startAgent(newest);
        await writeStatus();
        return;
      }
      const outcome = await agent.applyBundle(text);
      attempted = newest.generation;
      record({ at: p.now(), generation: outcome.generation, outcome: outcome.outcome, reason: outcome.outcome === "refused" ? outcome.reason : null, detail: outcome.outcome === "refused" && outcome.detail ? outcome.detail.slice(0, 200) : null, source: "exchange", object: newest.object });
      p.log({ event: "bundle_applied", generation: newest.generation, outcome: outcome.outcome, reason: outcome.outcome === "refused" ? outcome.reason : null, held: outcome.outcome === "refused" ? (outcome.held ?? null) : null, object: newest.object });
      if (outcome.outcome === "activated") {
        p.writeVendored(text);
        phase = "serving";
      }
      await writeStatus();
    } catch (error) {
      p.log({ event: "apply_tick_failed", message: (error as Error).message.slice(0, 300) });
    } finally {
      applying = false;
    }
  };

  const renderTick = async (): Promise<void> => {
    if (!agent || agent.generation === 0) return;
    const subject = subjects[cursor % subjects.length]!;
    cursor += 1;
    try {
      const rendered = await agent.prompt(PROBE_TAG, { subject }).renderAsync({ ticket: PROBE_TICKET });
      // The observation: the call was refused on this host — no route to any model — with no latency and no usage. Nothing invented.
      agent.report({ tag: rendered.tag, versionId: rendered.versionId, arm: rendered.arm, model: rendered.model, status: "refused", latencyMs: 0, usageSource: "unavailable" });
      renders.count += 1;
      renders.lastAt = p.now();
      renders.last = { tag: rendered.tag, versionId: rendered.versionId, arm: rendered.arm, model: rendered.model, subject };
      p.log({ event: "render_probe", tag: rendered.tag, versionId: rendered.versionId, arm: rendered.arm, model: rendered.model, generation: agent.generation, subject, observation: "refused", chars: rendered.text.length });
    } catch (error) {
      p.log({ event: "render_probe_failed", name: (error as Error).name, message: (error as Error).message.slice(0, 200) });
    }
  };

  return {
    async boot() {
      await startAgent(null);
    },
    applyTick,
    renderTick,
    writeStatus,
    async stop(signal) {
      p.log({ event: "stopping", signal, renders: renders.count, generation: agent?.generation ?? null });
      await writeStatus();
      if (agent) await agent.stop();
    },
    get agent() { return agent; },
    get attempted() { return attempted; },
    get phase() { return agent && agent.generation > 0 ? "serving" : phase; },
    get applies() { return applies; },
    get renders() { return renders; },
    get startFailure() { return startFailure; },
  };
}

async function main(): Promise<void> {
  const env: AirgapEnv = readAirgapEnv();
  const sdk = `${SDK_NAME}/${SDK_VERSION}`;
  const rootJwk = JSON.parse(readFileSync(env.airprompter.rootJwkPath, "utf8")) as Record<string, unknown>;
  if (rootJwk.d !== undefined) throw new Error(`${env.airprompter.rootJwkPath} carries a private member`);
  const { key: distributionKey, keyId } = parseDistributionKeyFile(readFileSync(env.distributionKeyPath, "utf8"), statSync(env.distributionKeyPath).mode);
  const ec2 = await readEc2Identity();
  const s3 = new S3Client({ region: env.region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }));
  const scope = `release#${env.airprompter.agentId}/${env.airprompter.environment}`;
  log({ event: "runtime_started", hostId: env.hostId, keyId, ec2: ec2?.instanceId ?? null, stateDir: env.stateDir, sdk, runtime: RUNTIME_VERSION });

  // The SDK's own words on the bundle it boots on: the logger is the only place `start()` reports the vendored outcome.
  let vendoredOutcomes: ApplyRecord[] = [];
  const sdkLogger = (event: Record<string, unknown>): void => {
    log({ source: "airprompter-sdk", ...event });
    const match = /^vendored_bundle_(applied|activated|staged|refused|unusable|held_back)$/.exec(String(event.event ?? ""));
    if (match) vendoredOutcomes.push({ at: new Date().toISOString(), generation: typeof event.generation === "number" ? event.generation : typeof event.bundleGeneration === "number" ? event.bundleGeneration : null, outcome: (match[1] === "applied" ? "activated" : match[1] === "unusable" ? "refused" : match[1]) as BundleOutcome["outcome"], reason: typeof event.reason === "string" ? event.reason : null, detail: null, source: "vendored", object: null });
  };

  const runtime = createRuntime({
    hostId: env.hostId,
    region: env.region,
    keyId,
    sdk,
    ec2,
    async newestRow() {
      const out = await ddb.send(new QueryCommand({ TableName: env.releasesTable, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": scope }, ScanIndexForward: false, Limit: 1 }));
      const item = out.Items?.[0] as (NewestRow & { pk: string }) | undefined;
      return item ? { generation: item.generation, releaseDigest: item.releaseDigest, keyId: item.keyId ?? null, object: item.object, pulledAt: item.pulledAt } : null;
    },
    async fetchBundle(object) {
      const out = await s3.send(new GetObjectCommand({ Bucket: env.exchangeBucket, Key: object }));
      if (!out.Body) throw new Error(`${object}: empty object`);
      return out.Body.transformToString("utf8");
    },
    async start() {
      try {
        const agent = await AirPrompterAgent.start({
          organizationId: env.airprompter.organizationId,
          agentId: env.airprompter.agentId,
          target: env.airprompter.environment,
          stateDir: env.stateDir,
          root: { pinned: rootJwk as never, hostedEnvironment: env.airprompter.hostedEnvironment },
          sync: { mode: "offline" },
          distributionKey,
          ...(existsSync(env.vendoredBundlePath) ? { vendoredBundle: { bundle: env.vendoredBundlePath } } : {}),
          apply: { policy: "auto" },
          // No `models`: this host declares no catalogue — it can call none — so no release is refused over a model; it renders only.
          telemetry: { sink: "directory", instanceClass: "resident" },
          logger: sdkLogger,
        });
        agent.onChange((change) => log({ event: "release_changed", generation: change.generation, stagedGeneration: change.stagedGeneration, applyState: agent.status().applyState }));
        return { agent };
      } catch (error) {
        return { agent: null, code: isAgentStartError(error) ? error.code : null, message: (error as Error).message };
      }
    },
    writeVendored: (text) => writeVendoredFile(env.vendoredBundlePath, text),
    async putStatus(doc) {
      await s3.send(new PutObjectCommand({ Bucket: env.exchangeBucket, Key: STATUS_KEY, Body: JSON.stringify(doc), ContentType: "application/json", CacheControl: "no-store" }));
    },
    readExport: () => readJsonFile<ExportInfo>(env.exportStatePath),
    readProbe: () => readJsonFile<ProbeInfo>(env.probePath),
    now: () => new Date().toISOString(),
    log,
    recentLog: () => recent,
    takeVendoredOutcomes: () => { const taken = vendoredOutcomes; vendoredOutcomes = []; return taken; },
  });

  await runtime.boot();
  await runtime.applyTick();
  await runtime.writeStatus();
  const timers = [
    setInterval(() => void runtime.applyTick(), env.applyIntervalSeconds * 1000),
    setInterval(() => void runtime.renderTick(), env.renderIntervalSeconds * 1000),
    setInterval(() => void runtime.writeStatus(), env.statusIntervalSeconds * 1000),
  ];
  const stop = async (signal: string): Promise<void> => {
    for (const t of timers) clearInterval(t);
    await runtime.stop(signal);
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  // The first render probe soon after start, so the first export has a window to carry.
  await sleep(5_000);
  await runtime.renderTick();
}

// Run as the main module only (compared by real path: the bundle is reached through /opt/zudocs); a test imports the helpers.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: Error & { code?: string }) => {
    log({ event: "runtime_failed", name: error.name, code: error.code ?? null, message: error.message.slice(0, 400) });
    process.exit(1);
  });
}
