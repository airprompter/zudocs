/**
 * Safe delivery facts from the public CLI's recorded status answer.
 * A daemon acknowledgment describes a segment, not a platform metrics row.
 * @example
 * const evidence = daemonDelivery(events, europeHost);
 */
import type { HostStatus, TimelineEvent } from "./api";
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const instant = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function daemonDelivery(events: TimelineEvent[], host: HostStatus | undefined) {
  if (!host?.ec2?.instanceId) return null;
  const event = [...events].filter((e) => e.kind === "host_cli" && e.command === "status" && e.status === "Success" && e.forHost === host.hostId && e.instanceId === host.ec2!.instanceId).sort((a,b)=>b.at.localeCompare(a.at))[0];
  const daemon = object(object(event?.document)?.daemon);
  const upload = object(daemon?.upload);
  const readAt = instant(event?.at);
  if (!daemon || !upload || !readAt) return null;
  return { readAt, live: daemon.live === true, lastUploadAt: instant(upload.lastUploadAt), sent: count(upload.sentSegments), quarantined: count(upload.quarantinedSegments), dropped: count(upload.droppedSegments), queued: count(upload.depthSegments), intervalSeconds: count(daemon.uploadIntervalSeconds) };
}
