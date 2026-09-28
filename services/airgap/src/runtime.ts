/**
 * The air-gapped runtime: the Agent SDK **offline** on a host with no route out. It holds no Agent key and never
 * calls home. The puller writes each sealed release into the exchange bucket in the SDK's datastore format; this
 * process hydrates from that store (`AirPrompterAgent.start({ datastore })`, then `hydrate()` on the apply
 * interval) and opens every bundle with the distribution keypair `airprompter keygen` generated on this host at
 * first boot (the private half at 0600 here, the public half in the exchange). A restart serves what the local
 * store already holds; an empty datastore is `no_verified_release` and is tried again on the next interval.
 *
 * - **renders**: every `ZUDOCS_RENDER_INTERVAL_SECONDS` one render of `support.triage` for a seeded customer id.
 *   The observation filed is `refused`: this host has no route to any model and says so; it never invents an answer.
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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { AirPrompterAgent, SDK_NAME, SDK_VERSION, distributionKeyId, isAgentStartError, kvReleaseDatastore, x25519PrivateKeyFromRaw, type AgentStatus, type DistributionKey, type Healthz, type HydrateOutcome, type Observation } from "@airprompter/agent-sdk";
import { s3KvStore } from "@airprompter/datastore-s3";
import { SEED_CUSTOMERS } from "../../desk-api/src/seedData.js";
import { readAirgapEnv, type AirgapEnv } from "./env.js";
import { buildStatusDoc, type AirgapPhase, type AirgapStatusDoc, type ApplyRecord, type ExportInfo, type ProbeInfo, type RenderInfo, type StartFailure } from "./status.js";

const RUNTIME_VERSION = "0.1.0";
/** The slot the render probe resolves and the end-user text it is given — a fixed sentence, never a ticket. */
export const PROBE_TAG = "support.triage";
export const PROBE_TICKET = "[render-only probe: this host has no route to a model and runs no ticket]";
/** A start the SDK refused for a reason other than an empty datastore is not retried for this long. */
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

/** What the loop needs of the SDK: the part of `AirPrompterAgent` it calls (a fake in a test). */
export interface Agent {
  readonly generation: number;
  readonly instanceId: string;
  status(): AgentStatus;
  healthz(): Healthz;
  hydrate(): Promise<HydrateOutcome>;
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
  /** Start the SDK on the local store and the datastore; null when it could not (logged with the SDK's code). */
  start(): Promise<{ agent: Agent } | { agent: null; code: string | null; message: string }>;
  putStatus(doc: AirgapStatusDoc): Promise<void>;
  readExport(): ExportInfo | null;
  readProbe(): ProbeInfo | null;
  now(): string;
  log(event: Record<string, unknown>): void;
  recentLog(): Array<Record<string, unknown>>;
}

export interface Runtime {
  hydrateTick(): Promise<void>;
  renderTick(): Promise<void>;
  writeStatus(): Promise<void>;
  stop(signal: string): Promise<void>;
  readonly agent: Agent | null;
  readonly phase: AirgapPhase;
  readonly applies: ApplyRecord[];
  readonly renders: RenderInfo;
  readonly startFailure: StartFailure | null;
}

const recordOf = (at: string, outcome: HydrateOutcome): ApplyRecord => ({
  at,
  generation: outcome.generation,
  outcome: outcome.outcome,
  reason: outcome.outcome === "refused" ? outcome.reason : outcome.outcome === "unavailable" ? "unavailable" : null,
  detail: "detail" in outcome && outcome.detail ? outcome.detail.slice(0, 200) : null,
  source: "datastore",
  object: null,
});

/** The loop over its ports. `boot()` is the first thing to call: a store from an earlier run starts without the datastore. */
export function createRuntime(p: RuntimePorts): Runtime & { boot(): Promise<void> } {
  const startedAt = p.now();
  const applies: ApplyRecord[] = [];
  const renders: RenderInfo = { count: 0, lastAt: null, last: null, observation: "refused" };
  let agent: Agent | null = null;
  let phase: AirgapPhase = "awaiting_bundle";
  let startFailure: StartFailure | null = null;
  let seq = 0;
  let hydrating = false;
  const subjects = SEED_CUSTOMERS.map((c) => c.customerId);
  let cursor = 0;

  const record = (entry: ApplyRecord): void => {
    applies.push(entry);
    if (applies.length > 50) applies.shift();
  };
  const startAgent = async (): Promise<boolean> => {
    const started = await p.start();
    if ("agent" in started && started.agent) {
      agent = started.agent;
      phase = agent.generation > 0 ? "serving" : "awaiting_bundle";
      startFailure = null;
      const datastore = agent.status().datastore;
      if (datastore?.lastOutcome) {
        record({ at: p.now(), generation: datastore.newestGeneration || null, outcome: datastore.lastOutcome, reason: null, detail: null, source: "datastore", object: null });
      }
      p.log({ event: "sdk_started", instanceId: agent.instanceId, generation: agent.generation, source: agent.status().source, storageProtection: agent.status().storageProtection, syncMode: "offline", datastore: datastore?.lastOutcome ?? null });
      return true;
    }
    startFailure = { at: p.now(), generation: null, releaseDigest: null, code: started.code, message: started.message.slice(0, 300) };
    p.log({ event: "sdk_not_started", code: started.code, message: started.message.slice(0, 300), retryAfterMs: started.code === "no_verified_release" ? 0 : START_RETRY_MS });
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

  const hydrateTick = async (): Promise<void> => {
    if (hydrating) return;
    hydrating = true;
    try {
      if (!agent) {
        if (startFailure && startFailure.code !== "no_verified_release" && Date.parse(p.now()) - Date.parse(startFailure.at) < START_RETRY_MS) return;
        await startAgent();
        await writeStatus();
        return;
      }
      const outcome = await agent.hydrate();
      record(recordOf(p.now(), outcome));
      if (agent.generation > 0) phase = "serving";
      p.log({ event: "hydrated", outcome: outcome.outcome, generation: outcome.generation, held: agent.generation });
      await writeStatus();
    } catch (error) {
      p.log({ event: "hydrate_tick_failed", message: (error as Error).message.slice(0, 300) });
    } finally {
      hydrating = false;
    }
  };

  const renderTick = async (): Promise<void> => {
    if (!agent || agent.generation === 0) return;
    const subject = subjects[cursor % subjects.length]!;
    cursor += 1;
    try {
      const rendered = await agent.prompt(PROBE_TAG, { subject }).renderAsync({ ticket: PROBE_TICKET });
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
      await startAgent();
    },
    hydrateTick,
    renderTick,
    writeStatus,
    async stop(signal) {
      p.log({ event: "stopping", signal, renders: renders.count, generation: agent?.generation ?? null });
      await writeStatus();
      if (agent) await agent.stop();
    },
    get agent() { return agent; },
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
  const datastore = kvReleaseDatastore(s3KvStore({ client: s3, bucket: env.exchangeBucket }));
  log({ event: "runtime_started", hostId: env.hostId, keyId, ec2: ec2?.instanceId ?? null, stateDir: env.stateDir, sdk, runtime: RUNTIME_VERSION, region: env.region });

  const runtime = createRuntime({
    hostId: env.hostId,
    region: env.region,
    keyId,
    sdk,
    ec2,
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
          datastore: { store: datastore, region: env.region },
          apply: { policy: "auto" },
          telemetry: { sink: "directory", instanceClass: "resident" },
          logger: (event) => log({ source: "airprompter-sdk", ...event }),
        });
        agent.onChange((change) => log({ event: "release_changed", generation: change.generation, stagedGeneration: change.stagedGeneration, applyState: agent.status().applyState }));
        return { agent };
      } catch (error) {
        return { agent: null, code: isAgentStartError(error) ? error.code : null, message: (error as Error).message };
      }
    },
    async putStatus(doc) {
      await s3.send(new PutObjectCommand({ Bucket: env.exchangeBucket, Key: STATUS_KEY, Body: JSON.stringify(doc), ContentType: "application/json", CacheControl: "no-store" }));
    },
    readExport: () => readJsonFile<ExportInfo>(env.exportStatePath),
    readProbe: () => readJsonFile<ProbeInfo>(env.probePath),
    now: () => new Date().toISOString(),
    log,
    recentLog: () => recent,
  });

  await runtime.boot();
  await runtime.hydrateTick();
  await runtime.writeStatus();
  const timers = [
    setInterval(() => void runtime.hydrateTick(), env.applyIntervalSeconds * 1000),
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
  await sleep(5_000);
  await runtime.renderTick();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: Error & { code?: string }) => {
    log({ event: "runtime_failed", name: error.name, code: error.code ?? null, message: error.message.slice(0, 400) });
    process.exit(1);
  });
}
