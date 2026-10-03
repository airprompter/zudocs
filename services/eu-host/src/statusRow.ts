/**
 * The host's row in the status table. The worker's `status()` and `healthz()` are the host's word: this process
 * loads its own release. The telemetry daemon does not serve one, so nothing here is copied off a socket.
 * The Python worker merges its own part under `python` with the same shape.
 *
 * @example
 * ```ts
 * const fields = statusFields({ hostId, region, status: ap.status(), healthz: ap.healthz(), sdk, tickets: 3, startedAt, now });
 * await store.updateStatus(hostId, fields);   // SET each field; the Python worker's `python` field survives
 * ```
 */
import type { AgentStatus, Healthz } from "@airprompter/agent-sdk";

export interface StatusInput {
  hostId: string;
  region: string;
  /** Null until `AirPrompterAgent.start` has returned. */
  status: AgentStatus | null;
  healthz: Healthz | null;
  sdk: string;
  tickets: number;
  startedAt: string;
  now: string;
  /** From IMDSv2 at start, when the host answered; the EC2 instance id and zone. */
  ec2?: { instanceId: string; availabilityZone: string } | null;
}

export function statusFields(input: StatusInput): Record<string, unknown> {
  const serving = input.status !== null && input.status.generation > 0;
  return {
    region: input.region,
    kind: "daemon",
    sdk: input.sdk,
    writtenAt: input.now,
    status: input.status,
    healthz: input.healthz ?? { ok: false, status: "failing", reasons: ["sdk_not_started"] },
    container: { instanceId: input.status?.instanceId ?? null, coldStart: false, startedAt: input.startedAt, invocations: input.tickets },
    worker: input.status
      ? { instanceId: input.status.instanceId, sdk: input.sdk, startedAt: input.startedAt, tickets: input.tickets, source: input.status.source, attached: serving, healthz: input.healthz?.status ?? "unknown", reasons: input.healthz?.reasons ?? [] }
      : { instanceId: null, sdk: input.sdk, startedAt: input.startedAt, tickets: input.tickets, source: null, attached: false, healthz: "unknown", reasons: ["sdk_not_started"] },
    ec2: input.ec2 ?? null,
  };
}
