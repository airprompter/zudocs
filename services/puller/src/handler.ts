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
import { advance, countNudge, objectKeyOf, parseTrigger, planPull, pullerHealth, type KeyInExchange, type PullerState, type ReleaseRow } from "./plan.js";
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
  if (key.malformed) log({ event: publicKey.reason?.startsWith("denied:") ? "public_key_unreadable" : "public_key_malformed", reason: key.malformed });
  let keyReadable = true;
  let apiKey: string | null = null;
  try {
    apiKey = await d.agentKey();
  } catch (error) {
    keyReadable = false;
    log({ event: "agent_key_unreadable", parameter: env.agentKeyParameter, name: (error as Error).name, message: (error as Error).message.slice(0, 200) });
  }
  // A nudge the puller cannot honour (no Agent key) is not counted or announced: the queue retries it, and one click is one row.
  if (!keyReadable && trigger.kind === "nudge") {
    await writePullerRow(d, { state, newest, key, keyReadable, now, airgapStatus: null });
    throw new Error(`the Agent key parameter ${env.agentKeyParameter} is unreadable; the nudge was not honoured`);
  }
  if (trigger.kind === "nudge") {
    // Counted and announced once per message id, whatever brings the message back — the queue's redelivery, or a run
    // of this puller that lost the state's version race and runs again on the fresh state.
    const counted = countNudge(state, trigger.messageIds);
    if (counted) {
      // The count and the id are written before the pull, so a run that loses the race later (or a redelivery) finds them.
      state = counted;
      version = await d.releases.writeState(state, version);
      await d.desk.appendEvent({ at: now, kind: "nudged", host: env.hostId, by: trigger.by, sentAt: trigger.sentAt, messages: trigger.messageIds.length });
      log({ event: "nudged", by: trigger.by, messages: trigger.messageIds.length });
    } else {
      log({ event: "nudge_seen_before", messages: trigger.messageIds.length });
    }
  }
  const plan = planPull({ now, trigger, state, newest, key });

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
      // A conflict that stood for an older generation is over once a newer one is written.
      state = next.conflict && result.generation > next.conflict.generation ? { ...next, conflict: null } : next;
      if (written.written) {
        await d.desk.appendEvent({ at: now, kind: "bundle_pulled", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, object, bytes: row.bytes, trigger: row.via, sealed: key.keyId !== null, previous: newest?.generation ?? null });
        log({ event: "bundle_pulled", generation: result.generation, releaseDigest: result.releaseDigest, keyId: key.keyId, object, bytes: row.bytes, trigger: row.via, pointerKnown: next.edge?.pointerUrl !== null });
      } else {
        // The same generation with a different digest never happens on an honest control plane: say so loudly, keep the
        // row (its object is its own: the key carries the digest), and keep saying so on the card until a newer generation lands.
        await d.desk.appendEvent({ at: now, kind: "pull_conflict", host: env.hostId, generation: result.generation, releaseDigest: result.releaseDigest, held: newest?.releaseDigest ?? null, object });
        log({ event: "pull_conflict", generation: result.generation, releaseDigest: result.releaseDigest, held: newest?.releaseDigest ?? null, object });
        state = { ...state, conflict: { generation: result.generation, releaseDigest: result.releaseDigest, at: now } };
        version = await d.releases.writeState(state, version);
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
      state = next;
    }
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

  // --- latest.json: what the table's newest row says, repaired whenever the last write did not match it ----------------
  const current = generation !== null ? await d.releases.newest() : newest;
  if (current && (state.latest?.generation !== current.generation || state.latest?.keyId !== current.keyId || state.latest?.object !== current.object)) {
    await d.exchange.writeLatest({ generation: current.generation, releaseDigest: current.releaseDigest, keyId: current.keyId, object: current.object, pulledAt: current.pulledAt, notAfter: current.notAfter });
    state = { ...state, latest: { generation: current.generation, keyId: current.keyId, object: current.object } };
    version = await d.releases.writeState(state, version);
  }

  // --- The air-gapped host's document, mirrored when it changed ------------------------------------------------------
  const { doc, denied: airgapStatus } = await d.exchange.readStatusDoc();
  if (airgapStatus) log({ event: "airgap_status_unreadable", reason: airgapStatus });
  if (doc && doc.writtenAt !== state.airgap.writtenAt) {
    const mirrored = mirrorAirgap({ doc, previous: state.airgap, now, keyIdInExchange: key.keyId });
    await d.desk.updateStatus(env.airgapHostId, mirrored.fields);
    for (const event of mirrored.events) await d.desk.appendEvent({ ...event, host: env.airgapHostId });
    if (mirrored.events.length > 0) log({ event: "airgap_mirrored", writtenAt: doc.writtenAt, phase: doc.phase, generation: doc.status?.generation ?? null, events: mirrored.events.map((e) => e.kind) });
    state = { ...state, airgap: mirrored.next };
    version = await d.releases.writeState(state, version);
  }

  await writePullerRow(d, { state, newest: current, key, keyReadable, now, airgapStatus });
  coldStart = false;
  return { plan: plan.reason, outcome, generation };
}

/** The puller's own row in the desk's status table. */
async function writePullerRow(d: PullerDeps, input: { state: PullerState; newest: ReleaseRow | null; key: KeyInExchange; keyReadable: boolean; now: string; airgapStatus: string | null }): Promise<void> {
  const { env } = d;
  const { state, newest: current, key, keyReadable, now, airgapStatus } = input;
  const healthz = pullerHealth({ keyReadable, lastPull: state.lastPull, newest: current, key, reseal: state.reseal, conflict: state.conflict, airgapStatus });
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
      conflict: state.conflict,
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
