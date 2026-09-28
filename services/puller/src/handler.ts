/**
 * The puller: the one process in ap-southeast-1 that holds the Agent key. Woken by the schedule (a tick) or by the
 * nudge queue (a message the desk posted), it does one `pullToDatastore` — the SDK writes the sealed release into
 * the S3 datastore (this region's rows), then the edge state, and never the other way around. An idle interval is
 * one CDN read of the edge pointer and no API call; a nudge passes `skipPointer`. The bundle is sealed to the
 * air-gapped host's distribution public key when the exchange holds one (a dev plaintext bundle otherwise; the SDK
 * refuses plaintext on any other target, and a malformed key object stops the puller rather than downgrading it).
 * `nextPullDelayMs` stretches the interval, in ticks, while nothing changes or every pull fails; a tick with ticks
 * to skip does nothing but the status row. Every tick also mirrors the host's `status/airgap.json` into the desk's
 * status table and turns what changed into timeline rows.
 *
 * Logs are JSON lines with generations, digests, key ids and outcomes — never a bundle's contents, never the key.
 *
 * @example
 * ```ts
 * export const handler = async (event) => ...;   // { action: "tick" } from EventBridge, or SQS Records with { by, at } bodies
 * ```
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Context } from "aws-lambda";
import { SDK_NAME, SDK_VERSION, SyncClient, kvReleaseDatastore, pullToDatastore, trustedRootFromPinnedKey, type P256PublicJwk, type ReleaseDatastore, type RootMetadata } from "@airprompter/agent-sdk";
import { s3KvStore } from "@airprompter/datastore-s3";
import { readPullerEnv, type PullerEnv } from "./env.js";
import { createExchange, type Exchange } from "./exchange.js";
import { mirrorAirgap } from "./mirror.js";
import { advance, countNudge, parseTrigger, planPull, pullerHealth, type KeyInExchange, type PullerState } from "./plan.js";
import { createDeskTables, createPullerState, RaceLost, type DeskTables, type PullerStateStore } from "./tables.js";

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), source: "zudocs-puller", ...event }));
const containerId = `puller-${Math.random().toString(36).slice(2, 10)}`;
const startedAt = new Date().toISOString();
let invocations = 0;
let coldStart = true;

/** The Agent key: read by name from SSM once per container, decrypted by SSM, never logged, never put in the environment. */
let cachedKey: string | null = null;
async function agentKey(env: PullerEnv): Promise<string> {
  if (cachedKey) return cachedKey;
  const out = await new SSMClient({ region: env.region }).send(new GetParameterCommand({ Name: env.agentKeyParameter, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`the SSM parameter ${env.agentKeyParameter} has no value`);
  cachedKey = value;
  return value;
}

export interface PullerDeps {
  env: PullerEnv;
  /** The SDK's release datastore (S3 in production, a memory store in a test). */
  datastore: ReleaseDatastore;
  /** The puller's schedule, beside the datastore, not inside it. */
  remembered: PullerStateStore;
  exchange: Exchange;
  desk: DeskTables;
  agentKey: () => Promise<string>;
  fetch: typeof fetch;
  now: () => string;
  /** The SDK's `pullToDatastore` (a fake in a test). */
  pull: typeof pullToDatastore;
}

let deps: PullerDeps | null = null;
function realDeps(): PullerDeps {
  if (deps) return deps;
  const env = readPullerEnv();
  const marshall = { marshallOptions: { removeUndefinedValues: true } };
  const s3 = new S3Client({ region: env.region });
  deps = {
    env,
    datastore: kvReleaseDatastore(s3KvStore({ client: s3, bucket: env.exchangeBucket })),
    remembered: createPullerState(s3, env.exchangeBucket),
    exchange: createExchange(s3, env.exchangeBucket),
    desk: createDeskTables(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.tablesRegion }), marshall), { status: env.statusTable, events: env.eventsTable }),
    agentKey: () => agentKey(env),
    fetch: globalThis.fetch,
    now: () => new Date().toISOString(),
    pull: pullToDatastore,
  };
  return deps;
}

export interface PassResult {
  plan: string;
  outcome: string | null;
  generation: number | null;
}

/** One tick or one nudge, over the dependencies: the real ones in production, fakes in a test. */
export async function pass(d: PullerDeps, event: unknown): Promise<PassResult> {
  const { env } = d;
  invocations += 1;
  const now = d.now();
  const trigger = parseTrigger(event);
  const read = await d.remembered.read();
  let state: PullerState = read.state;
  let version = read.version;
  const releaseKey = { organizationId: env.airprompter.organizationId, agentId: env.airprompter.agentId, target: env.airprompter.environment, region: env.region };
  const held = await d.datastore.latest(releaseKey);
  const publicKey = await d.exchange.readPublicKey();
  const key: KeyInExchange = { keyId: publicKey.key?.keyId ?? null, malformed: publicKey.reason && publicKey.reason !== "absent" ? publicKey.reason : null };
  if (key.malformed) log({ event: publicKey.reason?.startsWith("denied:") ? "public_key_unreadable" : "public_key_malformed", reason: key.malformed });
  let keyReadable = true;
  let apiKey: string | null = null;
  try {
    apiKey = await d.agentKey();
  } catch (error) {
    keyReadable = false;
    log({ event: "agent_key_unreadable", parameter: env.agentKeyParameter, name: (error as Error).name, message: (error as Error).message.slice(0, 200) });
  }
  if (!keyReadable && trigger.kind === "nudge") {
    await writePullerRow(d, { state, newestGeneration: held?.generation ?? null, key, keyReadable, now, airgapStatus: null });
    throw new Error(`the Agent key parameter ${env.agentKeyParameter} is unreadable; the nudge was not honoured`);
  }
  if (trigger.kind === "nudge") {
    const counted = countNudge(state, trigger.messageIds);
    if (counted) {
      state = counted;
      version = await d.remembered.write(state, version);
      await d.desk.appendEvent({ at: now, kind: "nudged", host: env.hostId, by: trigger.by, sentAt: trigger.sentAt, messages: trigger.messageIds.length });
      log({ event: "nudged", by: trigger.by, messages: trigger.messageIds.length });
    } else {
      log({ event: "nudge_seen_before", messages: trigger.messageIds.length });
    }
  }
  const plan = planPull({ now, trigger, state, key });

  let outcome: string | null = null;
  let generation: number | null = null;
  if (plan.pull && apiKey) {
    const client = new SyncClient({ baseUrl: env.airprompter.baseUrl, agentId: env.airprompter.agentId, target: env.airprompter.environment, apiKey, fetch: d.fetch as never, userAgent: "zudocs-puller/0.1.0" });
    const pinned = JSON.parse(env.airprompter.rootJwk) as P256PublicJwk & { d?: unknown };
    if (pinned.d !== undefined) throw new Error("the pinned root carries a private member");
    const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: env.airprompter.hostedEnvironment, pinnedRoot: { kty: "EC", crv: "P-256", x: pinned.x, y: pinned.y } });
    const fetchRoot = async (): Promise<RootMetadata | null> => {
      const response = await d.fetch(env.airprompter.rootUrl, { headers: { "user-agent": "zudocs-puller/0.1.0" } });
      return response.status === 200 ? ((await response.json()) as RootMetadata) : null;
    };
    const result = await d.pull({
      datastore: d.datastore,
      region: env.region,
      client,
      scope: { organizationId: env.airprompter.organizationId, agentId: env.airprompter.agentId, target: env.airprompter.environment },
      trustedRoot,
      fetchRoot,
      now: () => d.now(),
      distributionPublicKey: publicKey.key?.raw ?? null,
      skipPointer: plan.skipPointer,
    });
    outcome = result.status;
    const next = advance(state, result, { now, intervalMs: env.pullIntervalSeconds * 1000, trigger: trigger.kind });
    if (result.status === "ok") {
      generation = result.generation;
      if (result.stored) {
        await d.desk.appendEvent({ at: now, kind: "bundle_pulled", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, bytes: Buffer.byteLength(result.bundle ? JSON.stringify(result.bundle) : ""), trigger: trigger.kind, sealed: key.keyId !== null, previous: held?.generation ?? null });
        log({ event: "bundle_pulled", generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, trigger: trigger.kind, stored: true });
      } else {
        log({ event: "release_already_held", generation: result.generation, releaseDigest: result.releaseDigest });
      }
    } else if (result.status === "unchanged") {
      log({ event: "unchanged", via: result.via, generation: held?.generation ?? 0, streak: next.unchangedStreak, skipTicks: next.skipTicks, nextPullAt: next.nextPullAt, reads: next.reads, trigger: plan.reason });
    } else {
      const reason = next.lastPull?.reason ?? null;
      const detail = next.lastPull?.detail ?? null;
      log({ event: "pull_failed", outcome: result.status, reason, detail, trigger: plan.reason, failureStreak: next.failureStreak, skipTicks: next.skipTicks });
      const same = state.lastPull && state.lastPull.outcome === result.status && state.lastPull.reason === reason;
      if (!same) await d.desk.appendEvent({ at: now, kind: "pull_failed", host: env.hostId, outcome: result.status, reason, detail, trigger: plan.reason });
    }
    version = await d.remembered.write(next, version);
    state = next;
  } else if (!plan.pull) {
    if (plan.reason === "backoff") {
      state = { ...state, skipTicks: state.skipTicks - 1 };
      log({ event: "backoff_skip", skipTicksLeft: state.skipTicks, nextPullAt: plan.nextPullAt, unchangedStreak: state.unchangedStreak, failureStreak: state.failureStreak });
    } else {
      log({ event: "pull_skipped", reason: plan.reason });
    }
    version = await d.remembered.write(state, version);
  } else {
    version = await d.remembered.write(state, version);
  }

  const current = await d.datastore.latest(releaseKey);
  const { doc, denied: airgapStatus } = await d.exchange.readStatusDoc();
  if (airgapStatus) log({ event: "airgap_status_unreadable", reason: airgapStatus });
  if (doc && doc.writtenAt !== state.airgap.writtenAt) {
    const mirrored = mirrorAirgap({ doc, previous: state.airgap, now, keyIdInExchange: key.keyId });
    await d.desk.updateStatus(env.airgapHostId, mirrored.fields);
    for (const row of mirrored.events) await d.desk.appendEvent({ ...row, host: env.airgapHostId });
    if (mirrored.events.length > 0) log({ event: "airgap_mirrored", writtenAt: doc.writtenAt, phase: doc.phase, generation: doc.status?.generation ?? null, events: mirrored.events.map((e) => e.kind) });
    state = { ...state, airgap: mirrored.next };
    version = await d.remembered.write(state, version);
  }

  await writePullerRow(d, { state, newestGeneration: current?.generation ?? null, releaseDigest: current?.releaseDigest ?? null, pulledAt: current?.createdAt ?? null, key, keyReadable, now, airgapStatus });
  coldStart = false;
  return { plan: plan.reason, outcome, generation };
}

/** The puller's own row in the desk's status table. */
async function writePullerRow(d: PullerDeps, input: { state: PullerState; newestGeneration: number | null; releaseDigest?: string | null; pulledAt?: string | null; key: KeyInExchange; keyReadable: boolean; now: string; airgapStatus: string | null }): Promise<void> {
  const { env } = d;
  const { state, newestGeneration, key, keyReadable, now, airgapStatus } = input;
  const healthz = pullerHealth({ keyReadable, lastPull: state.lastPull, newestGeneration, key, airgapStatus });
  await d.desk.updateStatus(env.hostId, {
    region: env.region,
    kind: "puller",
    sdk: `${SDK_NAME}/${SDK_VERSION} (pullToDatastore)`,
    writtenAt: now,
    status: {
      generation: newestGeneration ?? 0,
      releaseDigest: input.releaseDigest ?? null,
      pulledAt: input.pulledAt ?? null,
      recipientKeyId: key.keyId,
      region: env.region,
      lastPull: state.lastPull,
      unchangedStreak: state.unchangedStreak,
      failureStreak: state.failureStreak,
      skipTicks: state.skipTicks,
      nextPullAt: state.nextPullAt,
      reads: state.reads,
      nudges: state.nudges,
      intervalSeconds: env.pullIntervalSeconds,
      agentKeyParameter: env.agentKeyParameter,
      airgapMirroredAt: state.airgap.writtenAt,
    },
    healthz,
    container: { instanceId: containerId, coldStart, startedAt, invocations },
  });
}

export const handler = async (event: unknown, _context?: Context): Promise<PassResult> => runOnce(realDeps(), event);

/** One invocation: a lost race is not an error — a tick stops (the winner's word stands); a nudge runs once more on the fresh state, so what a person asked for is never dropped (its message id keeps it counted once). */
export async function runOnce(d: PullerDeps, event: unknown): Promise<PassResult> {
  const isRace = (error: unknown): boolean => error instanceof RaceLost || (error as Error)?.name === "RaceLost";
  try {
    return await pass(d, event);
  } catch (error) {
    if (isRace(error)) {
      if (parseTrigger(event).kind === "nudge") {
        log({ event: "state_race_lost", message: (error as Error).message, retrying: true });
        try {
          return await pass(d, event);
        } catch (again) {
          if (!isRace(again)) throw again;
          log({ event: "state_race_lost", message: (again as Error).message, retrying: false });
          throw again;
        }
      }
      log({ event: "state_race_lost", message: (error as Error).message });
      return { plan: "race_lost", outcome: null, generation: null };
    }
    const e = error as Error & { code?: string };
    log({ event: "pass_failed", name: e.name, code: e.code ?? null, message: e.message.slice(0, 300) });
    throw error;
  }
}
