/**
 * The host: one AirPrompter Agent SDK instance per Lambda container, started at cold start and kept for the
 * container's life — `on_invoke` sync (a pull before each invocation, the invocation's telemetry flushed under the
 * runtime's own grant before it returns), the slot store under `/tmp` encrypted with a data key that KMS wraps
 * (`customKeyProvider`: one Encrypt on the first open, one Decrypt on every later one — `storageProtection: kms`
 * on the heartbeat), the Agent key read from an SSM SecureString by NAME at start and held in memory only, the
 * `customer_tier` variable sourced from the desk's own customer table, `apply.policy: "auto"` (a Lambda container
 * has nobody to unlock it), `golden.invoke` (T34: every staged release's golden sets run against the pinned model
 * before the apply decision — a set below its floor leaves the release staged, under `auto` too), and the tee on the
 * fetch port so every window also lands in CloudWatch. Phase 6 adds the hosted client for staging (`hosted.ts`),
 * started on the first "Run on staging".
 *
 * Every model observation the SDK files (latency, tokens, usage source, checks counts, error class) is also captured
 * for the request that made the call, by tapping the public spool writer — the desk shows the SDK's numbers, never
 * its own stopwatch.
 *
 * @example
 * ```ts
 * const host = await getHost();                 // memoised; a failed start is retried by the next invocation (SDK #52's fresh-store race: once, at once)
 * const { ap } = host;
 * await ap.invoke(async () => { ... ap.prompt("support.reply", { subject }).renderAsync(values) ... });
 * ```
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { AirPrompterAgent, SDK_NAME, SDK_VERSION, customKeyProvider } from "@airprompter/agent-sdk";
import { createCallers, createGoldenCaller, type Callers } from "./bedrock.js";
import { readEnv, type DeskEnv } from "./env.js";
import { createHostedClient, type HostedClient } from "./hosted.js";
import { runHostCli, type HostCliCommand, type HostCliResult } from "./hostCli.js";
import { createDemoModePorts, invokePower, type DemoModePorts, type PowerAction, type PowerAnswer } from "./hostPower.js";
import { MODELS } from "./modelCatalogue.js";
import { collectObservations, tapObservations, type Observed } from "./observe.js";
import { createStore, type Store } from "./store.js";
import { teeFetch } from "./tee.js";

export { collectObservations, tapObservations } from "./observe.js";

/** What a run needs of a host — the us-east container and the eu-west worker both provide it (`run.ts`). */
export interface RunHost {
  readonly env: Pick<DeskEnv, "hostId">;
  readonly ap: AirPrompterAgent;
  readonly store: Store;
  readonly callers: Callers;
  /** Run `fn` and collect the observations the SDK files while it runs — on a failure too; never throws. */
  observed<T>(fn: () => Promise<T>): Promise<Observed<T>>;
}

export interface Host extends RunHost {
  readonly env: DeskEnv;
  readonly startedAt: string;
  readonly sdk: string;
  invocations: number;
  /** True on the invocation that started this container; false on every later one. */
  coldStart: boolean;
  /** This host's status document, written to the status table. */
  writeStatus(): Promise<void>;
  /** One message on the fleet's nudge queue (the change-notification placeholder); the message id, or null when no queue is configured. */
  nudge(body: Record<string, unknown>): Promise<{ messageId: string | null }>;
  /** The hosted staging client (null when the deployment names no run key parameter or run URL). */
  readonly hosted: HostedClient | null;
  /** One allowlisted `zudocs-cli` command on the eu-west host through Run Command (`hostCli.ts`); a fake in tests. */
  hostCli(command: HostCliCommand, timeoutSeconds?: number): Promise<HostCliResult>;
  /** The eu-west power function (`hostPower.ts`): sleep, wake, tick; a fake in tests. */
  power(action: PowerAction, by: string): Promise<PowerAnswer>;
  /** The demo-mode switch (null when the deployment names no parameter). */
  readonly demoMode: DemoModePorts | null;
}

let pending: Promise<Host> | null = null;

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

/**
 * SDK #52: on a fresh store whose first sync accepts a newer root document, the golden hook verifies the slot it just
 * staged against the root the agent held BEFORE the sync (`unknown_signing_key`), and the SDK reports it as a network
 * failure (`no_verified_release … could not be reached: slot A failed verification: unknown_signing_key`). The store
 * now holds the accepted root and the staged slot, so a second start on the same store succeeds. Pure.
 */
export function isFreshStoreRootRace(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return typeof e?.message === "string" && e.code === "no_verified_release" && /failed verification: unknown_signing_key/.test(e.message);
}

/** One start, retried once (and logged as such) when the failure is SDK #52's signature; anything else is thrown as it is. */
export async function startWithRetry(start: () => Promise<Host>, log: (event: Record<string, unknown>) => void, isRetryable: (error: unknown) => boolean = isFreshStoreRootRace): Promise<Host> {
  try {
    return await start();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    log({ event: "host_start_retried", reason: String((error as Error).message ?? error).slice(0, 200), issue: "airprompter-agent-sdk#52" });
    return start();
  }
}

export function getHost(): Promise<Host> {
  if (!pending) {
    pending = startWithRetry(startHost, (event) => console.log(JSON.stringify({ source: "desk", ...event }))).catch((error) => {
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
  // The golden caller needs no SDK: the hook runs inside the boot sync, before the observed callers exist.
  const golden = createGoldenCaller(env.region);
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
    golden: { invoke: golden, concurrency: 2 },
    fetch: teeFetch(globalThis.fetch as any, { namespace: env.emfNamespace, emit: (line) => process.stdout.write(line + "\n"), properties: { host: env.hostId } }),
    logger: log,
  });
  tapObservations(ap);
  const callers = createCallers(ap, env.region);
  const hosted = env.hosted.runKeyParameter && env.hosted.runUrl ? createHostedClient({ env: { hosted: env.hosted, hostId: env.hostId, region: env.region, agentId: env.airprompter.agentId }, store }) : null;
  const host: Host = {
    env,
    ap,
    store,
    callers,
    hosted,
    hostCli: (command, timeoutSeconds) => runHostCli({ region: env.euHost.region, nameTag: env.euHost.nameTag }, command, timeoutSeconds),
    power: (action, by) => invokePower(env.powerFunctionArn, { action, by }),
    demoMode: env.demoModeParameter ? createDemoModePorts(env.euHost.region, env.demoModeParameter) : null,
    startedAt,
    sdk: `${SDK_NAME}/${SDK_VERSION}`,
    invocations: 0,
    coldStart: true,
    observed: collectObservations,
    async nudge(body) {
      const region = /sqs\.([a-z0-9-]+)\.amazonaws\.com/.exec(env.nudgeQueueUrl)?.[1] ?? env.region;
      const out = await new SQSClient({ region }).send(new SendMessageCommand({ QueueUrl: env.nudgeQueueUrl, MessageBody: JSON.stringify(body) }));
      return { messageId: out.MessageId ?? null };
    },
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
