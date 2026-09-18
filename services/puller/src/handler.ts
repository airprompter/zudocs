/**
 * The puller: the one process in ap-southeast-1 that holds the Agent key. Woken by the schedule (a tick) or by the
 * nudge queue (a message the desk posted), it does one `pullBundle` — the SDK's pointer-first pull: an idle interval
 * is one CDN read of the edge pointer and no API call; only a moved pointer, a nudge (`skipPointer`) or a pointer
 * that has said "nothing moved" for over an hour reaches the origin, conditionally — sealed to the air-gapped host's
 * distribution public key when the exchange holds one (a dev plaintext bundle otherwise; the SDK refuses plaintext on
 * any other target), and writes the generation as a row in the releases table and a bundle object in the exchange,
 * with the pointer's ETags beside the row in one transaction. When the host publishes a new key the held generation
 * is pulled again and sealed to it. `nextPullDelayMs` stretches the interval while nothing changes; a tick inside the
 * backoff window does nothing but the status row. Every tick also mirrors the host's `status/airgap.json` into the
 * desk's status table (a host with no route out cannot write it) and turns what changed into timeline rows.
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
import { advance, objectKeyOf, parseTrigger, planPull, pullerHealth, type PullerState, type ReleaseRow } from "./plan.js";
import { createDeskTables, createReleasesTable, type DeskTables, type ReleasesTable } from "./tables.js";

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

/** One tick or one nudge, over the dependencies: the real ones in production, fakes in a test. */
export async function pass(d: PullerDeps, event: unknown): Promise<{ plan: string; outcome: string | null; generation: number | null }> {
  const { env } = d;
  invocations += 1;
  const now = d.now();
  const trigger = parseTrigger(event);
  let state: PullerState = await d.releases.readState();
  const newest = await d.releases.newest();
  const publicKey = await d.exchange.readPublicKey();
  if (publicKey.reason && publicKey.reason !== "absent") log({ event: "public_key_malformed", reason: publicKey.reason });
  const keyId = publicKey.key?.keyId ?? null;
  if (trigger.kind === "nudge") {
    state = { ...state, nudges: state.nudges + 1 };
    await d.desk.appendEvent({ at: now, kind: "nudged", host: env.hostId, by: trigger.by, sentAt: trigger.sentAt, messages: trigger.messageIds.length });
    log({ event: "nudged", by: trigger.by, messages: trigger.messageIds.length });
  }
  const plan = planPull({ now, trigger, state, newest, keyId });
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
    const next = advance(state, result, { now, intervalMs: env.pullIntervalSeconds * 1000, trigger: plan.reason === "reseal" ? "reseal" : trigger.kind });
    if (result.status === "ok") {
      generation = result.generation;
      const text = JSON.stringify(result.bundle);
      const object = objectKeyOf(EXCHANGE_KEYS.releasesPrefix, result.generation, keyId);
      await d.exchange.writeBundle(object, text, { generation: String(result.generation), digest: result.releaseDigest, keyid: keyId ?? "plain", pulledat: result.createdAt });
      const row: Omit<ReleaseRow, "pk"> = { generation: result.generation, releaseDigest: result.releaseDigest, pulledAt: result.createdAt, keyId, object, bytes: Buffer.byteLength(text), notAfter: result.notAfter, via: plan.reason === "reseal" ? "reseal" : trigger.kind };
      const { written } = await d.releases.writeRelease(row, next);
      if (written) {
        await d.exchange.writeLatest({ generation: result.generation, releaseDigest: result.releaseDigest, keyId, object, pulledAt: result.createdAt, notAfter: result.notAfter });
        await d.desk.appendEvent({ at: now, kind: "bundle_pulled", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, keyId, object, bytes: row.bytes, trigger: row.via, sealed: keyId !== null, previous: newest?.generation ?? null });
        log({ event: "bundle_pulled", generation: result.generation, releaseDigest: result.releaseDigest, keyId, object, bytes: row.bytes, trigger: row.via, pointerKnown: next.edge?.pointerUrl !== null });
      } else {
        // The same generation with a different digest never happens on an honest control plane: say so loudly, keep the row.
        await d.desk.appendEvent({ at: now, kind: "pull_conflict", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, held: newest?.releaseDigest ?? null });
        log({ event: "pull_conflict", generation: result.generation, releaseDigest: result.releaseDigest, held: newest?.releaseDigest ?? null });
        await d.releases.writeState(next);
      }
    } else {
      if (result.status === "unchanged") log({ event: "unchanged", via: result.via, generation: newest?.generation ?? 0, streak: next.unchangedStreak, nextPullAt: next.nextPullAt, reads: next.reads, trigger: plan.reason });
      else {
        const reason = result.status === "nothing_promoted" ? "nothing_promoted" : result.reason;
        const detail = result.status === "nothing_promoted" ? null : (result.detail?.slice(0, 200) ?? null);
        log({ event: "pull_failed", outcome: result.status, reason, detail, trigger: plan.reason });
        await d.desk.appendEvent({ at: now, kind: "pull_failed", host: env.hostId, outcome: result.status, reason, detail, trigger: plan.reason });
      }
      await d.releases.writeState(next);
    }
    state = next;
  } else if (!plan.pull) {
    log({ event: "backoff_skip", nextPullAt: plan.nextPullAt, streak: state.unchangedStreak });
    await d.releases.writeState(state);
  }

  // --- The air-gapped host's document, mirrored when it changed ------------------------------------------------------
  const doc = await d.exchange.readStatusDoc();
  if (doc && doc.writtenAt !== state.airgap.writtenAt) {
    const mirrored = mirrorAirgap({ doc, previous: state.airgap, now, keyIdInExchange: keyId });
    await d.desk.updateStatus(env.airgapHostId, mirrored.fields);
    for (const event of mirrored.events) await d.desk.appendEvent({ ...event, host: env.airgapHostId });
    if (mirrored.events.length > 0) log({ event: "airgap_mirrored", writtenAt: doc.writtenAt, phase: doc.phase, generation: doc.status?.generation ?? null, events: mirrored.events.map((e) => e.kind) });
    state = { ...state, airgap: mirrored.next };
    await d.releases.writeState(state);
  }

  // --- The puller's own row ---------------------------------------------------------------------------------------------
  const current = generation !== null ? await d.releases.newest() : newest;
  const healthz = pullerHealth({ keyReadable, lastPull: state.lastPull, newest: current });
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
      recipientKeyId: keyId,
      edge: state.edge ? { pointerKnown: state.edge.pointerUrl !== null, pointerEtag: state.edge.pointerEtag, manifestEtag: state.edge.manifestEtag, lastOriginAt: state.edge.lastOriginAt } : null,
      lastPull: state.lastPull,
      unchangedStreak: state.unchangedStreak,
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
  coldStart = false;
  if (!keyReadable && trigger.kind === "nudge") throw new Error(`the Agent key parameter ${env.agentKeyParameter} is unreadable; the nudge was not honoured`);
  return { plan: plan.reason, outcome, generation };
}

export const handler = async (event: unknown, _context?: Context): Promise<{ plan: string; outcome: string | null; generation: number | null }> => {
  try {
    return await pass(realDeps(), event);
  } catch (error) {
    const e = error as Error & { code?: string };
    log({ event: "pass_failed", name: e.name, code: e.code ?? null, message: e.message.slice(0, 300) });
    throw error;
  }
};
