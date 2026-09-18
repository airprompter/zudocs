/**
 * The eu-west ticket worker: one Node process on the shared host beside `airprompterd`. It holds no key and opens
 * no store; the daemon syncs, verifies, stages under `unlock_required` and serves the release over its socket. What
 * this process does, in the order a fresh host needs:
 *
 * - **the daemon's socket first**: a plain `DaemonClient` (the SDK's public export) is the worker's window on the
 *   host — the daemon's own `status` and `healthz` documents, and its `unlock` op. Nothing else starts until the
 *   socket answers; a host whose daemon is down is a host that is not serving, and systemd retries (exit 3).
 * - **approvals** over that client (`ApprovalWatcher`): a release the daemon staged → a row the desk shows → the
 *   owner approves → `unlock` through the daemon → every attached SDK switches. This runs *before* any SDK attaches,
 *   because on a fresh store the first release lands staged and the SDK cannot attach until something is active.
 * - **status**: every 30 s the daemon's documents, merged into the host's row (with the worker's part beside them);
 *   every health transition is a timeline row.
 * - **the SDK**, attached in `sync: "daemon"` mode once the daemon serves a generation, and re-attached if it is
 *   lost; then **tickets**: every `ZUDOCS_TICKET_INTERVAL_SECONDS` one inbox ticket (the presenter's queue first,
 *   within ten seconds) through the same `runTicket` the us-east host uses — `support.triage` then `support.reply`
 *   on the release's models through Bedrock in us-east-1, the judge, the checks — with feedback filed from the SDK's
 *   own check verdicts, the record in the runs table with `host: eu-west-1/ec2`, under the fleet's shared daily cap.
 *
 * Logs are JSON lines with ids and counts — never a render, a ticket or an answer.
 *
 * @example
 * ```sh
 * # as the airprompter user, with /etc/airprompter/zudocs.env in the environment (systemd: zudocs-worker.service)
 * node /opt/zudocs/worker.mjs
 * ```
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AirPrompterAgent, DaemonClient, SDK_NAME, SDK_VERSION, daemonSocketPath, isDaemonError, type Healthz } from "@airprompter/agent-sdk";
import { createCallers } from "../../desk-api/src/bedrock.js";
import { MODELS } from "../../desk-api/src/modelCatalogue.js";
import { collectObservations, tapObservations } from "../../desk-api/src/observe.js";
import { runTicket, type StepRecord } from "../../desk-api/src/run.js";
import type { RunHost } from "../../desk-api/src/runtime.js";
import { createStore, dayOf, type Store, type Ticket } from "../../desk-api/src/store.js";
import { ApprovalWatcher } from "./approvals.js";
import { readHostEnv, type HostEnv } from "./hostEnv.js";
import { statusFields, type DaemonStatusDoc } from "./statusRow.js";

const WORKER_VERSION = "0.1.0";
const log = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), source: "zudocs-worker", ...event }) + "\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The instance id and zone from IMDSv2 (a token first; the host requires it); null off EC2 or when it does not answer. */
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

/** The timer's next ticket: the inbox round-robin by id (the cursor survives a re-seed, which keeps the ids). */
export async function nextInboxTicket(store: Pick<Store, "listTickets">, cursor: { last: string | null }): Promise<Ticket | null> {
  const tickets = (await store.listTickets()).sort((a, b) => (a.ticketId < b.ticketId ? -1 : 1));
  if (tickets.length === 0) return null;
  const index = cursor.last ? tickets.findIndex((t) => t.ticketId === cursor.last) : -1;
  const next = tickets[(index + 1) % tickets.length]!;
  cursor.last = next.ticketId;
  return next;
}

/** The presenter's queue: the oldest queued ticket that still exists, taken atomically; null when the queue is empty. */
export async function nextQueuedTicket(store: Pick<Store, "dequeueTicket" | "getTicket">, hostId: string): Promise<Ticket | null> {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queued = await store.dequeueTicket(hostId);
    if (!queued) return null;
    const ticket = await store.getTicket(queued);
    if (ticket) return ticket;
    // A queued id the inbox no longer holds (re-seeded away) is dropped; the next one is tried.
  }
  return null;
}

/** Feedback from the SDK's own verdicts: `accepted` when every declared check on the reply passed. Nothing is invented. */
export function feedbackFromChecks(step: Pick<StepRecord, "checks" | "runRef" | "output"> | undefined): { runRef: string; signals: { accepted: boolean } } | null {
  if (!step?.runRef || !step.output || step.checks.length === 0) return null;
  return { runRef: step.runRef, signals: { accepted: step.checks.every((c) => c.verdict === "pass") } };
}

/** The daemon's `unlock` answer as the watcher wants it: `{ generation }`, or null when nothing was staged. */
export function unlockResultOf(answer: Record<string, unknown>): { generation: number } | null {
  return typeof answer.generation === "number" ? { generation: answer.generation } : null;
}

/**
 * The daemon on its socket: one long-lived client, reconnected when it closes (the daemon restarts on every key
 * refresh). `connect()` answers null while the socket is absent; a failed `hello` (a scope mismatch, another owner)
 * throws and is not retried here.
 */
class Daemon {
  private client: DaemonClient | null = null;
  constructor(private readonly socketPath: string, private readonly scope: { agentId: string; target: "dev" | "staging" | "prod" }) {}
  async get(): Promise<DaemonClient | null> {
    if (this.client) return this.client;
    const client = await DaemonClient.connect({ socketPath: this.socketPath, agentId: this.scope.agentId, target: this.scope.target, sdk: `zudocs-worker/${WORKER_VERSION}` });
    if (!client) return null;
    client.onClose(() => {
      if (this.client === client) this.client = null;
    });
    this.client = client;
    return client;
  }
  get hello(): DaemonClient["hello"] | null {
    return this.client?.hello ?? null;
  }
  async request(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const client = await this.get();
    if (!client) throw Object.assign(new Error(`the daemon is not on ${this.socketPath}`), { code: "absent" });
    return client.request(op, params);
  }
  close(): void {
    this.client?.close();
    this.client = null;
  }
}

async function main(): Promise<void> {
  const env: HostEnv = readHostEnv();
  const startedAt = new Date().toISOString();
  const rootJwk = JSON.parse(readFileSync(env.airprompter.rootJwkPath, "utf8")) as Record<string, unknown>;
  if (rootJwk.d !== undefined) throw new Error(`${env.airprompter.rootJwkPath} carries a private member`);
  const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.tablesRegion }), { marshallOptions: { removeUndefinedValues: true } }), env.tables);
  const socketPath = daemonSocketPath({ stateDir: env.stateDir, agentId: env.airprompter.agentId, target: env.airprompter.environment });
  const daemon = new Daemon(socketPath, { agentId: env.airprompter.agentId, target: env.airprompter.environment });

  // The socket first: up to two minutes for the daemon to come up (its unit starts before this one), then exit 3.
  let client: DaemonClient | null = null;
  for (let waited = 0; !client && waited < 120_000; waited += 3000) {
    client = await daemon.get();
    if (!client) await sleep(3000);
  }
  if (!client) {
    log({ event: "daemon_absent", socketPath });
    process.exit(3);
  }
  const storeId = client.hello.storeId ?? client.hello.instanceId;
  const sdk = `${SDK_NAME}/${SDK_VERSION}`;
  const ec2 = await readEc2Identity();
  let latest: DaemonStatusDoc | null = null;
  const refresh = async (): Promise<DaemonStatusDoc | null> => {
    try {
      latest = (await daemon.request("status")) as unknown as DaemonStatusDoc;
    } catch (error) {
      log({ event: "daemon_status_unavailable", reason: (error as Error).message.slice(0, 200) });
      latest = null;
    }
    return latest;
  };
  const daemonHealthz = async (): Promise<(Healthz & Record<string, unknown>) | null> => daemon.request("healthz").then((h) => h as unknown as Healthz & Record<string, unknown>).catch(() => null);
  const first = await refresh();
  log({ event: "daemon_found", socketPath, daemon: client.hello.daemon, storeId, generation: first?.generation ?? null, stagedGeneration: first?.stagedGeneration ?? null, storageProtection: first?.storageProtection ?? null, applyPolicy: first?.applyPolicy ?? null });

  // --- The SDK: attached once the daemon serves a generation; re-attached when it is lost ----------------------------
  let ap: AirPrompterAgent | null = null;
  let host: RunHost | null = null;
  let attaching = false;
  const attach = async (): Promise<void> => {
    if (ap || attaching || !latest || latest.generation <= 0) return;
    attaching = true;
    try {
      const agent = await AirPrompterAgent.start({
        organizationId: env.airprompter.organizationId,
        agentId: env.airprompter.agentId,
        target: env.airprompter.environment,
        stateDir: env.stateDir,
        root: { pinned: rootJwk as never, hostedEnvironment: env.airprompter.hostedEnvironment },
        sync: { mode: "daemon", daemonSocketPath: socketPath },
        models: [...MODELS],
        variables: {
          customer_tier: { resolve: async ({ subject }) => (subject ? (await store.getCustomer(subject))?.tier : undefined), trust: "operator", timeoutMs: 1500 },
        },
        logger: (event) => log({ source: "airprompter-sdk", ...event }),
      });
      if (agent.status().source !== "daemon") {
        // The socket vanished between the check and the start: never a second, keyless, in-process sync.
        log({ event: "attach_fell_back", source: agent.status().source });
        await agent.stop();
        return;
      }
      tapObservations(agent);
      agent.onChange((change) => {
        void store.appendEvent({ at: new Date().toISOString(), kind: "release_changed", host: env.hostId, generation: change.generation, stagedGeneration: change.stagedGeneration, applyState: agent.status().applyState }).then(() => writeStatus()).catch((error) => log({ event: "event_write_failed", reason: (error as Error).message }));
      });
      ap = agent;
      host = { env: { hostId: env.hostId }, ap: agent, store, callers: createCallers(agent, env.bedrockRegion), observed: collectObservations };
      await store.appendEvent({ at: new Date().toISOString(), kind: "host_started", host: env.hostId, generation: agent.generation, stagedGeneration: agent.status().stagedGeneration, storageProtection: latest?.storageProtection ?? "daemon", source: "daemon", applyPolicy: latest?.applyPolicy?.effective ?? agent.status().applyPolicy.effective, sdk: `${sdk} via ${client!.hello.daemon}`, instanceId: agent.instanceId, daemonInstanceId: latest?.instanceId ?? null, ec2: ec2?.instanceId ?? null });
      log({ event: "sdk_attached", instanceId: agent.instanceId, generation: agent.generation });
    } catch (error) {
      log({ event: "attach_failed", reason: (error as Error).message.slice(0, 300) });
    } finally {
      attaching = false;
    }
  };

  // --- The status row ------------------------------------------------------------------------------------------------
  let tickets = 0;
  let lastHealth: string | null = null;
  const writeStatus = async (): Promise<void> => {
    const [d, h] = await Promise.all([refresh(), daemonHealthz()]);
    if (!d || !h) {
      await store.updateStatus(env.hostId, { region: env.region, kind: "daemon", sdk, writtenAt: new Date().toISOString(), healthz: { ok: false, status: "failing", reasons: ["daemon_status_unavailable"], generation: 0 }, worker: { instanceId: ap?.instanceId ?? null, sdk, startedAt, tickets, source: ap ? "daemon" : null, attached: ap?.status().daemon?.attached ?? false, healthz: "unknown", reasons: ["daemon_status_unavailable"] }, ec2 });
      return;
    }
    const worker = ap?.status() ?? null;
    await store.updateStatus(env.hostId, statusFields({ hostId: env.hostId, region: env.region, daemon: d, healthz: h, worker, workerHealthz: ap?.healthz() ?? null, sdk, tickets, startedAt, now: new Date().toISOString(), ec2 }));
    // The host's health, as the daemon judges it: a transition is a timeline row (the wire-cut beat reads here).
    const health = `${h.status}:${h.reasons.join(",")}`;
    if (lastHealth !== null && health !== lastHealth) {
      await store.appendEvent({ at: new Date().toISOString(), kind: "health_changed", host: env.hostId, status: h.status, reasons: h.reasons, generation: h.generation, consecutiveSyncFailures: h.consecutiveSyncFailures, leaseExpiresAt: h.leaseExpiresAt });
    }
    lastHealth = health;
  };

  // --- Approvals, over the daemon's socket ------------------------------------------------------------------------
  const watcher = new ApprovalWatcher({
    hostId: env.hostId,
    storeId,
    store,
    status: () => ({ generation: latest?.generation ?? 0, stagedGeneration: latest?.stagedGeneration ?? null, unlockRequests: ap?.status().unlockRequests ?? [] }),
    unlock: async () => unlockResultOf(await daemon.request("unlock")),
    isRefusal: (error) => isDaemonError(error) && error.code === "refused",
    now: () => new Date().toISOString(),
    log,
  });
  let settled = 0;
  try {
    settled = await watcher.reconcile();
  } catch (error) {
    // The approvals table may not exist yet on the very first deploy (the desk stack lands after this one); the
    // watcher's ticks keep trying and the row appears once it does.
    log({ event: "reconcile_failed", reason: (error as Error).message.slice(0, 200) });
  }
  await writeStatus().catch((error) => log({ event: "status_write_failed", reason: (error as Error).message }));
  await attach();
  const now = latest as DaemonStatusDoc | null;
  log({ event: "serving", hostId: env.hostId, generation: now?.generation ?? null, stagedGeneration: now?.stagedGeneration ?? null, attached: ap !== null, settledApprovals: settled, ec2: ec2?.instanceId ?? null });

  // --- Tickets -----------------------------------------------------------------------------------------------------------
  const cursor = { last: null as string | null };
  let running = false;
  const runOne = async (from: "timer" | "queue"): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const ticket = from === "queue" ? await nextQueuedTicket(store, env.hostId) : await nextInboxTicket(store, cursor);
      if (!ticket) return;
      if (!ap || !host || ap.generation === 0) {
        // Nothing verified to serve (a fresh host under unlock_required waiting for the desk's approval): say so, run nothing.
        log({ event: "ticket_skipped", reason: ap ? "no_verified_release" : "sdk_not_attached", ticketId: ticket.ticketId, from });
        return;
      }
      const day = dayOf(new Date().toISOString());
      const slot = await store.takeRunSlot(day, env.dailyRunCap);
      if (!slot.ok) {
        await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, capDay: day, cap: env.dailyRunCap, used: slot.used, by: env.by });
        return;
      }
      const agent = ap;
      const record = await agent.invoke(() => runTicket(host!, ticket, { by: `${env.by} (${from})`, kind: "run", capUsed: slot.used }));
      tickets += 1;
      const feedback = feedbackFromChecks(record.steps.find((s) => s.step === "reply"));
      if (feedback) {
        const filed = agent.feedback(feedback.runRef, feedback.signals);
        const at = new Date().toISOString();
        await store.putFeedback({ runId: record.runId, at, signals: feedback.signals, by: `${env.by} (checks)`, filed });
        await store.appendEvent({ at, kind: "feedback", host: env.hostId, runId: record.runId, ticketId: record.ticketId, step: "reply", signals: Object.keys(feedback.signals), filed, container: "same", by: `${env.by} (checks)` });
      }
      log({ event: "ticket_run", ticketId: record.ticketId, runId: record.runId, ok: record.ok, generation: record.generation, from, steps: record.steps.map((s) => ({ step: s.step, versionId: s.versionId, model: s.model, status: s.observation?.status ?? null, checks: s.checks.map((c) => c.verdict) })) });
    } catch (error) {
      log({ event: "ticket_run_failed", reason: (error as Error).message.slice(0, 300) });
    } finally {
      running = false;
      await writeStatus().catch((error) => log({ event: "status_write_failed", reason: (error as Error).message }));
    }
  };

  const timers = [
    // The daemon's word every five seconds, then the watcher on it, then the SDK once there is something to attach to.
    setInterval(() => void (async () => { await refresh(); await watcher.tick(); await attach(); })(), 5_000),
    setInterval(() => void writeStatus().catch((error) => log({ event: "status_write_failed", reason: (error as Error).message })), env.statusIntervalSeconds * 1000),
    setInterval(() => void runOne("timer"), env.ticketIntervalSeconds * 1000),
    // The presenter's queue is looked at every ten seconds: "run this ticket on eu-west now" runs within that.
    setInterval(() => void runOne("queue"), 10_000),
  ];

  const stop = async (signal: string) => {
    for (const t of timers) clearInterval(t);
    log({ event: "stopping", signal, tickets });
    await store.appendEvent({ at: new Date().toISOString(), kind: "worker_stopped", host: env.hostId, signal, tickets }).catch(() => undefined);
    daemon.close();
    if (ap) await ap.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

// Run as the main module only (compared by real path: the bundle is reached through /opt/zudocs); a test imports the helpers.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: Error & { code?: string }) => {
    log({ event: "worker_failed", name: error.name, code: error.code ?? null, message: error.message.slice(0, 400) });
    process.exit(1);
  });
}
