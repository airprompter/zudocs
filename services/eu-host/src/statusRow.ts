/**
 * The host's row in the status table, built from two documents: the daemon's own `status` and `healthz` (it is the
 * process that syncs, holds the store and the lease, and talks to AirPrompter — its word is the host's) and the
 * attached worker's `status()` (the variables it fills, its instance id, its own health) — null until the SDK attaches,
 * which on a fresh host is after the desk's first approval. Nothing is invented: a field the daemon does not put on
 * its socket (the heartbeat's last instant, for one) is absent, and the card says so.
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
  /** The attached worker's own status — null before the SDK attaches (a fresh host waiting for its first approval). */
  worker: AgentStatus | null;
  workerHealthz: Healthz | null;
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
      variables: worker?.variables ?? { sources: [], unsourced: [] },
      unlockRequests: worker?.unlockRequests ?? [],
      // Phase 6: what the attached SDK reads off the active manifest — the ramp plans it walks (one per experiment),
      // the standing directives (a freeze), the update window in force — and the golden run it last saw (none: the
      // daemon syncs and stages; the attached SDK has no golden hook).
      ramps: worker?.ramps ?? [],
      disabled: worker?.disabled ?? { agent: false, slots: [], arms: [] },
      window: worker?.window ?? null,
      golden: worker?.golden ?? null,
      forcedDowngrade: input.healthz.forcedDowngrade,
      daemon: { attached: true, socketPath: daemon.socketPath ?? null, version: daemon.daemon, clients: daemon.clients ?? null, uptimeSeconds: daemon.uptimeSeconds ?? null },
    },
    healthz: input.healthz,
    container: { instanceId: daemon.instanceId, coldStart: false, startedAt: daemon.startedAt, invocations: input.tickets },
    worker: worker ? { instanceId: worker.instanceId, sdk: input.sdk, startedAt: input.startedAt, tickets: input.tickets, source: worker.source, attached: worker.daemon?.attached ?? false, healthz: input.workerHealthz?.status ?? "unknown", reasons: input.workerHealthz?.reasons ?? [] } : { instanceId: null, sdk: input.sdk, startedAt: input.startedAt, tickets: input.tickets, source: null, attached: false, healthz: "unknown", reasons: [daemon.generation > 0 ? "sdk_attaching" : "awaiting_first_approval"] },
    ec2: input.ec2 ?? null,
  };
}
