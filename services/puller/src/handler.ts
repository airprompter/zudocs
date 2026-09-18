/**
 * The puller: the one process in ap-southeast-1 that holds the Agent key. Woken by the schedule (a tick) or by the
 * nudge queue (a message the desk posted), it does one `pullBundle` — the SDK's pointer-first pull: an idle interval
 * is one CDN read of the edge pointer and no API call; only a moved pointer, a nudge (`skipPointer`) or a pointer
 * that has said "nothing moved" for over an hour reaches the origin, conditionally — sealed to the air-gapped host's
 * distribution public key when the exchange holds one (a dev plaintext bundle otherwise; the SDK refuses plaintext on
 * any other target, and a malformed key object stops the puller rather than downgrading it), and writes the
 * generation as a row in the releases table and a bundle object in the exchange, with the pointer's ETags beside the
 * row in one transaction conditioned on the state's version (a nudge racing a tick loses cleanly). When the host
 * publishes a new key the held generation is pulled again and sealed to it (given up after three failures until the
 * key changes). `nextPullDelayMs` stretches the interval, in ticks, while nothing changes or every pull fails; a
 * tick with ticks to skip does nothing but the status row. Every tick also mirrors the host's `status/airgap.json`
 * into the desk's status table (a host with no route out cannot write it) and turns what changed into timeline rows.
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
import { SDK_NAME, SDK_VERSION, SyncClient, pullBundle, trustedRootFromPinnedKey, type P256PublicJwk, type RootMetadata } from "@airprompter/agent-sdk";
import { readPullerEnv, type PullerEnv } from "./env.js";
import { createExchange, EXCHANGE_KEYS, type Exchange } from "./exchange.js";
import { mirrorAirgap } from "./mirror.js";
import { advance, objectKeyOf, parseTrigger, planPull, pullerHealth, type KeyInExchange, type PullerState, type ReleaseRow } from "./plan.js";
import { createDeskTables, createReleasesTable, RaceLost, type DeskTables, type ReleasesTable } from "./tables.js";

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
  releases: ReleasesTable;
  exchange: Exchange;
  desk: DeskTables;
  agentKey: () => Promise<string>;
  fetch: typeof fetch;
  now: () => string;
  /** The SDK's `pullBundle` (a fake in a test). */
  pull: typeof pullBundle;
}

let deps: PullerDeps | null = null;
function realDeps(): PullerDeps {
  if (deps) return deps;
  const env = readPullerEnv();
  const scope = `${env.airprompter.agentId}/${env.airprompter.environment}`;
  const marshall = { marshallOptions: { removeUndefinedValues: true } };
  deps = {
    env,
    releases: createReleasesTable(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }), marshall), env.releasesTable, scope),
    exchange: createExchange(new S3Client({ region: env.region }), env.exchangeBucket),
    desk: createDeskTables(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.tablesRegion }), marshall), { status: env.statusTable, events: env.eventsTable }),
    agentKey: () => agentKey(env),
    fetch: globalThis.fetch,
    now: () => new Date().toISOString(),
    pull: pullBundle,
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
  const read = await d.releases.readState();
  let state: PullerState = read.state;
  let version = read.version;
  const newest = await d.releases.newest();
  const publicKey = await d.exchange.readPublicKey();
  const key: KeyInExchange = { keyId: publicKey.key?.keyId ?? null, malformed: publicKey.reason && publicKey.reason !== "absent" ? publicKey.reason : null };
  if (key.malformed) log({ event: "public_key_malformed", reason: key.malformed });
  if (trigger.kind === "nudge") {
    state = { ...state, nudges: state.nudges + 1 };
    await d.desk.appendEvent({ at: now, kind: "nudged", host: env.hostId, by: trigger.by, sentAt: trigger.sentAt, messages: trigger.messageIds.length });
    log({ event: "nudged", by: trigger.by, messages: trigger.messageIds.length });
  }
  const plan = planPull({ now, trigger, state, newest, key });
  let keyReadable = true;
  let apiKey: string | null = null;
  try {
    apiKey = await d.agentKey();
  } catch (error) {
    keyReadable = false;
    log({ event: "agent_key_unreadable", parameter: env.agentKeyParameter, name: (error as Error).name, message: (error as Error).message.slice(0, 200) });
  }

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
    // The pointer URL the control plane names is learned on the first origin read; until then the environment's is a hint.
    const edge = plan.edge ?? (env.airprompter.edgePointerUrl ? { pointerUrl: env.airprompter.edgePointerUrl, pointerEtag: null, manifestEtag: null, lastOriginAt: null } : null);
    // The newest generation held is the floor: the origin answering below it is `generation_rollback`, at it (a re-seal) is fine.
    const held = newest?.generation ?? 0;
    const result = await d.pull({ client, scope: { organizationId: env.airprompter.organizationId, agentId: env.airprompter.agentId, target: env.airprompter.environment }, trustedRoot, fetchRoot, minimumGeneration: held, now: () => d.now(), distributionPublicKey: publicKey.key?.raw ?? null, edge, skipPointer: plan.skipPointer });
    outcome = result.status;
    const trigger2 = plan.reason === "reseal" ? "reseal" : trigger.kind;
    const next = advance(state, result, { now, intervalMs: env.pullIntervalSeconds * 1000, trigger: trigger2, keyId: key.keyId });
    if (result.status === "ok") {
      generation = result.generation;
      const text = JSON.stringify(result.bundle);
      const object = objectKeyOf(EXCHANGE_KEYS.releasesPrefix, result.generation, result.releaseDigest, key.keyId);
      await d.exchange.writeBundle(object, text, { generation: String(result.generation), digest: result.releaseDigest, keyid: key.keyId ?? "plain", pulledat: result.createdAt });
      const row: Omit<ReleaseRow, "pk"> = { generation: result.generation, releaseDigest: result.releaseDigest, pulledAt: result.createdAt, keyId: key.keyId, object, bytes: Buffer.byteLength(text), notAfter: result.notAfter, via: trigger2 };
      const written = await d.releases.writeRelease(row, next, version);
      version = written.version;
      if (written.written) {
        await d.exchange.writeLatest({ generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, object, pulledAt: result.createdAt, notAfter: result.notAfter });
        await d.desk.appendEvent({ at: now, kind: "bundle_pulled", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, object, bytes: row.bytes, trigger: row.via, sealed: key.keyId !== null, previous: newest?.generation ?? null });
        log({ event: "bundle_pulled", generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, object, bytes: row.bytes, trigger: row.via, pointerKnown: next.edge?.pointerUrl !== null });
      } else {
        // The same generation with a different digest never happens on an honest control plane: say so loudly, keep the
        // row (its object is its own: the key carries the digest).
        await d.desk.appendEvent({ at: now, kind: "pull_conflict", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, held: newest?.releaseDigest ?? null, object });
        log({ event: "pull_conflict", generation: result.generation, releaseDigest: result.releaseDigest, held: newest?.releaseDigest ?? null, object });
      }
    } else {
      if (result.status === "unchanged") log({ event: "unchanged", via: result.via, generation: newest?.generation ?? 0, streak: next.unchangedStreak, skipTicks: next.skipTicks, nextPullAt: next.nextPullAt, reads: next.reads, trigger: plan.reason });
      else {
        const reason = next.lastPull?.reason ?? null;
        const detail = next.lastPull?.detail ?? null;
        log({ event: "pull_failed", outcome: result.status, reason, detail, trigger: plan.reason, failureStreak: next.failureStreak, skipTicks: next.skipTicks });
        // One timeline row per change of outcome, not one per tick: a control plane with nothing promoted is one row, not 288 a day.
        const same = state.lastPull && state.lastPull.outcome === result.status && state.lastPull.reason === reason;
        if (!same) await d.desk.appendEvent({ at: now, kind: "pull_failed", host: env.hostId, outcome: result.status, reason, detail, trigger: plan.reason });
      }
      version = await d.releases.writeState(next, version);
    }
    state = next;
  } else if (!plan.pull) {
    if (plan.reason === "backoff") {
      state = { ...state, skipTicks: state.skipTicks - 1 };
      log({ event: "backoff_skip", skipTicksLeft: state.skipTicks, nextPullAt: plan.nextPullAt, unchangedStreak: state.unchangedStreak, failureStreak: state.failureStreak });
    } else {
      log({ event: "pull_skipped", reason: plan.reason });
    }
    version = await d.releases.writeState(state, version);
  } else {
    // The key is unreadable: the plan stood but nothing was pulled; the row below says so.
    version = await d.releases.writeState(state, version);
  }

  // --- The air-gapped host's document, mirrored when it changed ------------------------------------------------------
  const doc = await d.exchange.readStatusDoc();
  if (doc && doc.writtenAt !== state.airgap.writtenAt) {
    const mirrored = mirrorAirgap({ doc, previous: state.airgap, now, keyIdInExchange: key.keyId });
    await d.desk.updateStatus(env.airgapHostId, mirrored.fields);
    for (const event of mirrored.events) await d.desk.appendEvent({ ...event, host: env.airgapHostId });
    if (mirrored.events.length > 0) log({ event: "airgap_mirrored", writtenAt: doc.writtenAt, phase: doc.phase, generation: doc.status?.generation ?? null, events: mirrored.events.map((e) => e.kind) });
    state = { ...state, airgap: mirrored.next };
    version = await d.releases.writeState(state, version);
  }

  // --- The puller's own row ---------------------------------------------------------------------------------------------
  const current = generation !== null ? await d.releases.newest() : newest;
  const healthz = pullerHealth({ keyReadable, lastPull: state.lastPull, newest: current, key, reseal: state.reseal });
  await d.desk.updateStatus(env.hostId, {
    region: env.region,
    kind: "puller",
    sdk: `${SDK_NAME}/${SDK_VERSION} (pullBundle)`,
    writtenAt: now,
    status: {
      generation: current?.generation ?? 0,
      releaseDigest: current?.releaseDigest ?? null,
      pulledAt: current?.pulledAt ?? null,
      keyId: current?.keyId ?? null,
      object: current?.object ?? null,
      recipientKeyId: key.keyId,
      edge: state.edge ? { pointerKnown: state.edge.pointerUrl !== null, pointerEtag: state.edge.pointerEtag, manifestEtag: state.edge.manifestEtag, lastOriginAt: state.edge.lastOriginAt } : null,
      lastPull: state.lastPull,
      unchangedStreak: state.unchangedStreak,
      failureStreak: state.failureStreak,
      skipTicks: state.skipTicks,
      nextPullAt: state.nextPullAt,
      reads: state.reads,
      nudges: state.nudges,
      reseal: state.reseal,
      intervalSeconds: env.pullIntervalSeconds,
      agentKeyParameter: env.agentKeyParameter,
      airgapMirroredAt: state.airgap.writtenAt,
    },
    healthz,
    container: { instanceId: containerId, coldStart, startedAt, invocations },
  });
  coldStart = false;
  if (!keyReadable && trigger.kind === "nudge") throw new Error(`the Agent key parameter ${env.agentKeyParameter} is unreadable; the nudge was not honoured`);
  return { plan: plan.reason, outcome, generation };
}

export const handler = async (event: unknown, _context?: Context): Promise<PassResult> => {
  try {
    return await pass(realDeps(), event);
  } catch (error) {
    if (error instanceof RaceLost || (error as Error).name === "RaceLost") {
      // Another invocation (a nudge during a tick, or the reverse) wrote the state first: it did the work; this one is done.
      log({ event: "state_race_lost", message: (error as Error).message });
      return { plan: "race_lost", outcome: null, generation: null };
    }
    const e = error as Error & { code?: string };
    log({ event: "pass_failed", name: e.name, code: e.code ?? null, message: e.message.slice(0, 300) });
    throw error;
  }
};
