/**
 * The host: one AirPrompter Agent SDK instance per Lambda container, started at cold start and kept for the
 * container's life — `on_invoke` sync (a pull before each invocation, the invocation's telemetry flushed under the
 * runtime's own grant before it returns), the slot store under `/tmp` encrypted with a data key that KMS wraps
 * (`customKeyProvider`: one Encrypt on the first open, one Decrypt on every later one — `storageProtection: kms`
 * on the heartbeat), the Agent key read from an SSM SecureString by NAME at start and held in memory only, the
 * `customer_tier` variable sourced from the desk's own customer table, `apply.policy: "auto"` (a Lambda container
 * has nobody to unlock it), and the tee on the fetch port so every window also lands in CloudWatch.
 *
 * Every model observation the SDK files (latency, tokens, usage source, checks counts, error class) is also captured
 * for the request that made the call, by tapping the public spool writer — the desk shows the SDK's numbers, never
 * its own stopwatch.
 *
 * @example
 * ```ts
 * const host = await getHost();                 // memoised; a failed start is retried by the next invocation
 * const { ap } = host;
 * await ap.invoke(async () => { ... ap.prompt("support.reply", { subject }).renderAsync(values) ... });
 * ```
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AirPrompterAgent, SDK_NAME, SDK_VERSION, customKeyProvider, type Observation } from "@airprompter/agent-sdk";
import { createCallers, type Callers } from "./bedrock.js";
import { readEnv, type DeskEnv } from "./env.js";
import { MODELS } from "./modelCatalogue.js";
import { createStore, type Store } from "./store.js";
import { teeFetch } from "./tee.js";

export interface Host {
  readonly env: DeskEnv;
  readonly ap: AirPrompterAgent;
  readonly store: Store;
  readonly callers: Callers;
  readonly startedAt: string;
  readonly sdk: string;
  invocations: number;
  /** True on the invocation that started this container; false on every later one. */
  coldStart: boolean;
  /** Run `fn` and collect the observations the SDK files while it runs — on a failure too; never throws. */
  observed<T>(fn: () => Promise<T>): Promise<{ result: T; error?: undefined; observations: Observation[] } | { result?: undefined; error: unknown; observations: Observation[] }>;
  /** This host's status document, written to the status table. */
  writeStatus(): Promise<void>;
}

const capture = new AsyncLocalStorage<Observation[]>();
let pending: Promise<Host> | null = null;

/**
 * The tap: the SDK's own observation for each model call, also handed to the request that made it. The spool writer
 * is a public property and every wrapper files through `spool.observe`, so an own property shadowing the method sees
 * each observation before the original writes it. (An `onObservation` listener on the SDK would make this a contract;
 * filed as a gap.) Idempotent: tapping twice keeps one tap.
 */
export function tapObservations(ap: { spool: { observe: (observation: Observation, nowMs: number) => void } }): void {
  const spool = ap.spool as { observe: (observation: Observation, nowMs: number) => void; [TAPPED]?: boolean };
  if (spool[TAPPED]) return;
  const original = spool.observe.bind(spool);
  spool.observe = (observation, nowMs) => {
    capture.getStore()?.push(observation);
    return original(observation, nowMs);
  };
  spool[TAPPED] = true;
}
const TAPPED = Symbol("zudocs.tapped");

/** Run `fn` with the observations the SDK files during it collected — the tap's other half; see `Host.observed`. */
export async function collectObservations<T>(fn: () => Promise<T>): Promise<{ result: T; error?: undefined; observations: Observation[] } | { result?: undefined; error: unknown; observations: Observation[] }> {
  const observations: Observation[] = [];
  // The wrappers file the observation when the call settles, one turn after the caller sees the result (or the
  // error): give the spool that turn — a bounded wait, so a call the wrapper never attributed still returns.
  const settled = await capture.run(observations, () => fn().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })));
  for (let waited = 0; observations.length === 0 && waited < 500; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  return settled.ok ? { result: settled.value, observations } : { error: settled.error, observations };
}

/** The Agent key: read by name from SSM, decrypted by SSM, never logged, never put back in the environment. */
async function readAgentKey(env: DeskEnv): Promise<string> {
  const ssm = new SSMClient({ region: env.region });
  let out;
  try {
    out = await ssm.send(new GetParameterCommand({ Name: env.agentKeyParameter, WithDecryption: true }));
  } catch (error) {
    throw new Error(`the SSM parameter ${env.agentKeyParameter} could not be read (${(error as Error).name}): the owner writes it with scripts/ssm-put-agent-key.sh after the stack deploys`);
  }
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`the SSM parameter ${env.agentKeyParameter} has no value (the owner writes it with --cli-input-json; see README)`);
  return value;
}

export function getHost(): Promise<Host> {
  if (!pending) {
    pending = startHost().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

async function startHost(): Promise<Host> {
  const env = readEnv();
  const startedAt = new Date().toISOString();
  const kms = new KMSClient({ region: env.region });
  const encryptionContext = { application: "zudocs-desk", environment: env.airprompter.environment };
  const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }), { marshallOptions: { removeUndefinedValues: true } }), env.tables);
  const apiKey = await readAgentKey(env);
  // The SDK's events are content-free by design; the one that echoes caller input (`feedback_rejected` maps each
  // rejected NAME a caller typed to a reason code) is reduced to the reason codes, so a log line never carries text
  // a person typed. (The handler files accepted signals only, so this line is rare.)
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ source: "airprompter-sdk", ...event, ...(event.event === "feedback_rejected" && typeof event.rejected === "object" && event.rejected !== null ? { rejected: Object.values(event.rejected as Record<string, unknown>) } : {}) }));
  const ap = await AirPrompterAgent.start({
    organizationId: env.airprompter.organizationId,
    agentId: env.airprompter.agentId,
    target: env.airprompter.environment as "dev" | "staging" | "prod",
    apiKey,
    baseUrl: env.airprompter.baseUrl,
    stateDir: env.stateDir,
    keyProvider: customKeyProvider({
      storageProtection: "kms",
      wrap: async (dek) => {
        const out = await kms.send(new EncryptCommand({ KeyId: env.kmsKeyId, Plaintext: dek, EncryptionContext: encryptionContext }));
        if (!out.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
        return out.CiphertextBlob;
      },
      unwrap: async (wrapped) => {
        const out = await kms.send(new DecryptCommand({ KeyId: env.kmsKeyId, CiphertextBlob: wrapped, EncryptionContext: encryptionContext }));
        if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
        return out.Plaintext;
      },
    }),
    root: { pinned: JSON.parse(env.airprompter.rootJwk), hostedEnvironment: env.airprompter.hostedEnvironment as "dev" | "staging" | "prod" },
    sync: { mode: "on_invoke", rootUrl: env.airprompter.rootUrl },
    apply: { policy: "auto" },
    heartbeatSeconds: env.heartbeatSeconds,
    models: [...MODELS],
    variables: {
      customer_tier: { resolve: async ({ subject }) => (subject ? (await store.getCustomer(subject))?.tier : undefined), trust: "operator", timeoutMs: 1500 },
    },
    telemetry: { flush: "await" },
    fetch: teeFetch(globalThis.fetch as any, { namespace: env.emfNamespace, emit: (line) => process.stdout.write(line + "\n"), properties: { host: env.hostId } }),
    logger: log,
  });
  tapObservations(ap);
  const host: Host = {
    env,
    ap,
    store,
    callers: createCallers(ap, env.region),
    startedAt,
    sdk: `${SDK_NAME}/${SDK_VERSION}`,
    invocations: 0,
    coldStart: true,
    observed: collectObservations,
    async writeStatus() {
      await store.putStatus({
        hostId: env.hostId,
        region: env.region,
        kind: "lambda",
        sdk: host.sdk,
        writtenAt: new Date().toISOString(),
        status: ap.status(),
        healthz: ap.healthz(),
        container: { instanceId: ap.instanceId, coldStart: host.coldStart, startedAt, invocations: host.invocations },
      });
    },
  };
  ap.onChange((change) => {
    void store.appendEvent({ at: new Date().toISOString(), kind: "release_changed", host: env.hostId, generation: change.generation, stagedGeneration: change.stagedGeneration, applyState: ap.status().applyState }).catch((error) => log({ event: "desk_event_write_failed", reason: (error as Error).message }));
  });
  const status = ap.status();
  await store.appendEvent({ at: startedAt, kind: "host_started", host: env.hostId, generation: status.generation, storageProtection: status.storageProtection, source: status.source, applyPolicy: status.applyPolicy.effective, sdk: host.sdk, instanceId: ap.instanceId });
  return host;
}
