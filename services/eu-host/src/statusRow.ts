/**
 * The host's row in the status table, built from two documents: the daemon's own `status` and `healthz` (it is the
 * process that syncs, holds the store and the lease, and talks to AirPrompter — its word is the host's) and the
 * attached worker's `status()` (the variables it fills, its instance id, its own health). Nothing is invented: a
 * field the daemon does not put on its socket (the heartbeat's last instant, for one) is absent, and the card says so.
 * The Python worker merges its own part under `python` with the same shape.
 *
 * @example
 * ```ts
 * const fields = statusFields({ hostId, region, daemon, healthz, worker: ap.status(), workerHealthz: ap.healthz(), sdk, tickets: 3, startedAt, now });
 * await store.updateStatus(hostId, fields);   // SET each field; the Python worker's `python` field survives
 * ```
 */
import type { AgentStatus, Healthz } from "@airprompter/agent-sdk";

/** The daemon's `status` op (cli/src/daemon/server.ts › DaemonStatus), the fields the desk reads. */
export interface DaemonStatusDoc {
  daemon: string;
  protocol?: string;
  pid?: number;
  startedAt: string;
  uptimeSeconds?: number;
  socketPath?: string;
  clients?: number;
  instanceId: string;
  generation: number;
  stagedGeneration: number | null;
  applyState: string;
  lastRefusal: string | null;
  storageProtection: string;
  signingKeyId?: string | null;
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  lastContactAt: string | null;
  lastSyncAt: string | null;
  lastSyncOutcome: string | null;
  consecutiveFailures: number;
  nextSyncAt?: string | null;
  spool: { depthSegments: number; depthBytes: number };
  upload: Record<string, unknown> | null;
  applyPolicy: AgentStatus["applyPolicy"];
}

export interface StatusInput {
  hostId: string;
  region: string;
  daemon: DaemonStatusDoc;
  healthz: Healthz & Record<string, unknown>;
  worker: AgentStatus;
  workerHealthz: Healthz;
  /** `agent-sdk-ts/0.2.14` — the worker's SDK; the daemon names itself in `daemon.daemon`. */
  sdk: string;
  tickets: number;
  startedAt: string;
  now: string;
  /** From IMDSv2 at start, when the host answered; the EC2 instance id and zone. */
  ec2?: { instanceId: string; availabilityZone: string } | null;
}

export function statusFields(input: StatusInput): Record<string, unknown> {
  const { daemon, worker } = input;
  return {
    region: input.region,
    kind: "daemon",
    sdk: `${input.sdk} via ${daemon.daemon}`,
    writtenAt: input.now,
    // The host's status: the daemon's fields under the names the desk's card reads (`AgentStatus`), with what the
    // socket does not carry left out rather than filled in.
    status: {
      instanceId: daemon.instanceId,
      generation: daemon.generation,
      stagedGeneration: daemon.stagedGeneration,
      applyState: daemon.applyState,
      lastRefusal: daemon.lastRefusal,
      storageProtection: daemon.storageProtection,
      signingKeyId: daemon.signingKeyId ?? null,
      leaseExpiresAt: daemon.leaseExpiresAt,
      leaseExpired: daemon.leaseExpired,
      lastContactAt: daemon.lastContactAt,
      lastSyncAt: daemon.lastSyncAt,
      lastSyncOutcome: daemon.lastSyncOutcome,
      consecutiveSyncFailures: daemon.consecutiveFailures,
      nextSyncAt: daemon.nextSyncAt ?? null,
      spool: daemon.spool,
      upload: daemon.upload,
      applyPolicy: daemon.applyPolicy,
      source: "store",
      // Not on the daemon's socket: the heartbeat block. The fleet page on AirPrompter shows it; the card says "by the daemon".
      heartbeat: null,
      variables: worker.variables,
      unlockRequests: worker.unlockRequests,
      forcedDowngrade: input.healthz.forcedDowngrade,
      daemon: { attached: true, socketPath: daemon.socketPath ?? null, version: daemon.daemon, clients: daemon.clients ?? null, uptimeSeconds: daemon.uptimeSeconds ?? null },
    },
    healthz: input.healthz,
    container: { instanceId: daemon.instanceId, coldStart: false, startedAt: daemon.startedAt, invocations: input.tickets },
    worker: { instanceId: worker.instanceId, sdk: input.sdk, startedAt: input.startedAt, tickets: input.tickets, source: worker.source, attached: worker.daemon?.attached ?? false, healthz: input.workerHealthz.status, reasons: input.workerHealthz.reasons },
    ec2: input.ec2 ?? null,
  };
}
