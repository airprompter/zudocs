/**
 * The air-gapped host's status document, mirrored into the desk's status table as the host's row, and the timeline
 * rows the puller derives from what changed since it last looked: the host started (a new `startedAt`), a bundle it
 * applied (every apply newer than the last mirrored), an export it wrote, a health transition, a key it published.
 * Pure: the document in, the row's fields and the events out, plus what to remember. The row's `writtenAt` is the
 * host's own instant (a torn-down host fades on the card exactly as a silent one would); `mirroredAt` is the puller's.
 *
 * @example
 * ```ts
 * const { fields, events, next } = mirrorAirgap({ doc, previous: state.airgap, now, keyIdInExchange });
 * await store.updateStatus(airgapHostId, fields);
 * for (const event of events) await store.appendEvent({ ...event, host: airgapHostId });
 * ```
 */
import type { AirgapStatusDoc } from "../../airgap/src/status.js";
import type { PullerState } from "./plan.js";

export interface Mirrored {
  fields: Record<string, unknown>;
  events: Array<Record<string, unknown> & { at: string; kind: string }>;
  next: PullerState["airgap"];
}

export function mirrorAirgap(input: { doc: AirgapStatusDoc; previous: PullerState["airgap"]; now: string; keyIdInExchange: string | null }): Mirrored {
  const { doc, previous, now } = input;
  const events: Mirrored["events"] = [];
  const healthNow = doc.healthz ? `${doc.healthz.status}:${(doc.healthz.reasons ?? []).join(",")}` : `${doc.phase}`;
  if (previous.startedAt !== doc.startedAt) {
    events.push({ at: doc.startedAt, kind: "airgap_started", instanceId: doc.ec2?.instanceId ?? null, keyId: doc.keyId, phase: doc.phase, sdk: doc.sdk });
  }
  if (doc.keyId && previous.keyId !== doc.keyId) {
    events.push({ at: doc.startedAt, kind: "distribution_key_born", keyId: doc.keyId, published: input.keyIdInExchange === doc.keyId });
  }
  // Every apply newer than the last one mirrored (the document keeps the newest twenty; a host that applied more
  // than twenty between two mirrors loses the older ones here, never the newest).
  const since = previous.lastAppliedAt;
  for (const apply of doc.applies) {
    if (since && apply.at <= since) continue;
    events.push({ at: apply.at, kind: "airgap_applied", generation: apply.generation, outcome: apply.outcome, reason: apply.reason, detail: apply.detail, source: apply.source, object: apply.object });
  }
  if (doc.export && previous.lastExportAt !== doc.export.at) {
    events.push({ at: doc.export.at, kind: "telemetry_exported", segments: doc.export.segments, bytes: doc.export.bytes, instances: doc.export.instances, object: doc.export.object, generation: doc.export.generation });
  }
  if (previous.health !== null && previous.health !== healthNow) {
    events.push({ at: doc.writtenAt, kind: "health_changed", status: doc.healthz?.status ?? doc.phase, reasons: doc.healthz?.reasons ?? [], generation: doc.status?.generation ?? null, consecutiveSyncFailures: null, leaseExpiresAt: doc.status?.leaseExpiresAt ?? null });
  }
  const lastAppliedAt = doc.applies.reduce<string | null>((max, a) => (max === null || a.at > max ? a.at : max), since);
  const fields: Record<string, unknown> = {
    region: doc.region,
    kind: "airgapped",
    sdk: doc.sdk,
    writtenAt: doc.writtenAt,
    mirroredAt: now,
    status: doc.status,
    healthz: doc.healthz ?? { ok: false, status: doc.phase === "serving" ? "ok" : "degraded", reasons: [doc.phase] },
    // `invocations` on this host is its own count of status writes (`seq`), the one number that is a count of anything the host did on its own.
    container: { instanceId: doc.status?.instanceId ?? doc.ec2?.instanceId ?? "airgap", coldStart: false, startedAt: doc.startedAt, invocations: doc.seq },
    ec2: doc.ec2,
    airgap: {
      keyId: doc.keyId,
      keyPublished: doc.keyId !== null && input.keyIdInExchange === doc.keyId,
      phase: doc.phase,
      waitingFor: doc.waitingFor,
      applies: doc.applies.slice(-5),
      renders: doc.renders,
      export: doc.export,
      probe: doc.probe,
      startFailure: doc.startFailure ?? null,
      seq: doc.seq,
    },
  };
  return { fields, events, next: { writtenAt: doc.writtenAt, startedAt: doc.startedAt, lastAppliedAt, lastExportAt: doc.export?.at ?? previous.lastExportAt, health: healthNow, keyId: doc.keyId ?? previous.keyId } };
}
