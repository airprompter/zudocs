/**
 * The eu-west ticket worker: one Node process on the shared host, attached to `airprompterd` in `sync: "daemon"`
 * mode — it holds no key and opens no store; the daemon syncs, verifies, stages under `unlock_required` and serves
 * the release over its socket, and every attached SDK switches when the daemon does. What this process does:
 *
 * - **tickets**: every `ZUDOCS_TICKET_INTERVAL_SECONDS` it runs one ticket from the desk's inbox (the presenter's
 *   queue first, then round-robin) through the same `runTicket` the us-east host uses — `support.triage` then
 *   `support.reply` on the release's models through Bedrock in us-east-1 under `aiSdkMiddleware()` / `wrap()`, the
 *   judge, the checks — and files feedback from the SDK's own check verdicts (`accepted` when every declared check
 *   passed); the record lands in the runs table with `host: eu-west-1/ec2`, under the fleet's shared daily cap;
 * - **approvals**: the `ApprovalWatcher` (a release the daemon staged → a row the desk shows → the owner approves →
 *   `ap.unlock()` through the daemon → the host card flips);
 * - **status**: every 30 s the daemon's `status` + `healthz` and this process's own, merged into the host's row;
 *   `onChange` and every health transition go to the timeline.
 *
 * Refuses to run without the daemon (no silent in-process fallback: a host with the daemon down is a host that is
 * not serving, and systemd retries). Logs are JSON lines with ids and counts — never a render, a ticket or an answer.
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
import { AirPrompterAgent, DaemonClient, SDK_NAME, SDK_VERSION, daemonSocketPath, type AgentStatus, type Healthz } from "@airprompter/agent-sdk";
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

async function main(): Promise<void> {
  const env: HostEnv = readHostEnv();
  const startedAt = new Date().toISOString();
  const rootJwk = JSON.parse(readFileSync(env.airprompter.rootJwkPath, "utf8")) as Record<string, unknown>;
  if (rootJwk.d !== undefined) throw new Error(`${env.airprompter.rootJwkPath} carries a private member`);
  const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.tablesRegion }), { marshallOptions: { removeUndefinedValues: true } }), env.tables);
  const socketPath = daemonSocketPath({ stateDir: env.stateDir, agentId: env.airprompter.agentId, target: env.airprompter.environment });

  const ap = await AirPrompterAgent.start({
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
  if (ap.status().source !== "daemon" || !ap.status().daemon?.attached) {
    // No daemon on the socket: this process must not become a second, keyless, in-process sync. systemd retries.
    log({ event: "daemon_absent", socketPath });
    await ap.stop();
    process.exit(3);
  }
  tapObservations(ap);
  const sdk = `${SDK_NAME}/${SDK_VERSION}`;
  const ec2 = await readEc2Identity();

  // A second, plain client on the daemon's socket for the documents the attached SDK does not surface: the daemon's
  // own status and healthz (the host's sync state, lease, spool, key protection).
  let daemon: DaemonClient | null = null;
  const daemonClient = async (): Promise<DaemonClient | null> => {
    if (daemon) return daemon;
    daemon = await DaemonClient.connect({ socketPath, agentId: env.airprompter.agentId, target: env.airprompter.environment, sdk: `zudocs-worker/${WORKER_VERSION}` }).catch(() => null);
    daemon?.onClose(() => {
      daemon = null;
    });
    return daemon;
  };
  const daemonStatus = async (): Promise<DaemonStatusDoc | null> => ((await daemonClient())?.request("status").catch(() => null) as Promise<DaemonStatusDoc | null>) ?? null;
  const daemonHealthz = async (): Promise<(Healthz & Record<string, unknown>) | null> => ((await daemonClient())?.request("healthz").catch(() => null) as Promise<(Healthz & Record<string, unknown>) | null>) ?? null;

  let tickets = 0;
  let lastHealth: string | null = null;
  const writeStatus = async (): Promise<void> => {
    const [d, h] = await Promise.all([daemonStatus(), daemonHealthz()]);
    if (!d || !h) {
      log({ event: "daemon_status_unavailable" });
      await store.updateStatus(env.hostId, { region: env.region, kind: "daemon", sdk, writtenAt: new Date().toISOString(), status: ap.status(), healthz: { ...ap.healthz(), reasons: [...ap.healthz().reasons, "daemon_status_unavailable"] }, container: { instanceId: ap.instanceId, coldStart: false, startedAt, invocations: tickets }, ec2 });
      return;
    }
    await store.updateStatus(env.hostId, statusFields({ hostId: env.hostId, region: env.region, daemon: d, healthz: h, worker: ap.status(), workerHealthz: ap.healthz(), sdk, tickets, startedAt, now: new Date().toISOString(), ec2 }));
    // The host's health, as the daemon judges it: a transition is a timeline row (the wire-cut beat reads here).
    const health = `${h.status}:${h.reasons.join(",")}`;
    if (lastHealth !== null && health !== lastHealth) {
      await store.appendEvent({ at: new Date().toISOString(), kind: "health_changed", host: env.hostId, status: h.status, reasons: h.reasons, generation: h.generation, consecutiveSyncFailures: h.consecutiveSyncFailures, leaseExpiresAt: h.leaseExpiresAt });
    }
    lastHealth = health;
  };

  const first = await daemonStatus();
  await store.appendEvent({ at: startedAt, kind: "host_started", host: env.hostId, generation: ap.generation, stagedGeneration: ap.status().stagedGeneration, storageProtection: first?.storageProtection ?? "daemon", source: "daemon", applyPolicy: first?.applyPolicy?.effective ?? ap.status().applyPolicy.effective, sdk: `${sdk} via ${first?.daemon ?? "airprompterd"}`, instanceId: ap.instanceId, daemonInstanceId: first?.instanceId ?? null, ec2: ec2?.instanceId ?? null });
  ap.onChange((change) => {
    void store.appendEvent({ at: new Date().toISOString(), kind: "release_changed", host: env.hostId, generation: change.generation, stagedGeneration: change.stagedGeneration, applyState: ap.status().applyState }).then(() => writeStatus()).catch((error) => log({ event: "event_write_failed", reason: (error as Error).message }));
  });

  const host: RunHost = { env: { hostId: env.hostId }, ap, store, callers: createCallers(ap, env.bedrockRegion), observed: collectObservations };
  const cursor = { last: null as string | null };
  let running = false;
  /** One ticket through the promoted prompts, under the fleet's daily cap; feedback from the checks; never throws. */
  const runOne = async (from: "timer" | "queue"): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const ticket = from === "queue" ? await nextQueuedTicket(store, env.hostId) : await nextInboxTicket(store, cursor);
      if (!ticket) return;
      if (ap.generation === 0) {
        // Nothing verified to serve (a fresh host under unlock_required, or a lease that halted): say so, run nothing.
        log({ event: "ticket_skipped", reason: "no_verified_release", ticketId: ticket.ticketId, from });
        return;
      }
      const day = dayOf(new Date().toISOString());
      const slot = await store.takeRunSlot(day, env.dailyRunCap);
      if (!slot.ok) {
        await store.appendEvent({ at: new Date().toISOString(), kind: "cap_refused", host: env.hostId, ticketId: ticket.ticketId, capDay: day, cap: env.dailyRunCap, used: slot.used, by: env.by });
        return;
      }
      const record = await ap.invoke(() => runTicket(host, ticket, { by: `${env.by} (${from})`, kind: "run", capUsed: slot.used }));
      tickets += 1;
      const feedback = feedbackFromChecks(record.steps.find((s) => s.step === "reply"));
      if (feedback) {
        const filed = ap.feedback(feedback.runRef, feedback.signals);
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

  const watcher = new ApprovalWatcher({
    hostId: env.hostId,
    store,
    status: () => {
      const s: AgentStatus = ap.status();
      return { generation: s.generation, stagedGeneration: s.stagedGeneration, unlockRequests: s.unlockRequests };
    },
    // (The daemon's socket names no release digest for the staged slot; the row carries the generation only.)
    unlock: () => ap.unlock(),
    now: () => new Date().toISOString(),
    log,
  });
  const settled = await watcher.reconcile();
  await writeStatus();
  log({ event: "serving", hostId: env.hostId, generation: ap.generation, stagedGeneration: ap.status().stagedGeneration, socketPath, sdk, daemon: first?.daemon ?? null, storageProtection: first?.storageProtection ?? null, applyPolicy: first?.applyPolicy ?? null, settledApprovals: settled, ec2: ec2?.instanceId ?? null });

  const timers = [
    setInterval(() => void watcher.tick(), 5_000),
    setInterval(() => void writeStatus().catch((error) => log({ event: "status_write_failed", reason: (error as Error).message })), env.statusIntervalSeconds * 1000),
    setInterval(() => void runOne("timer"), env.ticketIntervalSeconds * 1000),
    // The presenter's queue is looked at every ten seconds: "run this ticket on eu-west now" runs within that.
    setInterval(() => void runOne("queue"), 10_000),
  ];

  const stop = async (signal: string) => {
    for (const t of timers) clearInterval(t);
    log({ event: "stopping", signal, tickets });
    await store.appendEvent({ at: new Date().toISOString(), kind: "worker_stopped", host: env.hostId, signal, tickets }).catch(() => undefined);
    daemon?.close();
    await ap.stop();
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
