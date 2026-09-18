/**
 * The air-gapped host's status document — what it writes to `status/airgap.json` in the exchange bucket every
 * minute, because a host with no route out cannot reach the desk's status table in us-east-1. The puller mirrors it
 * into the table as the host's row and derives timeline rows from what changed. Nothing here is invented: the SDK's
 * own `status()` and `healthz()` are carried verbatim, every apply outcome is the SDK's `BundleOutcome`, the render
 * count is the host's own, the export line is what the export timer wrote, and the probe is what the boot measured.
 *
 * @example
 * ```ts
 * const doc = buildStatusDoc({ hostId, region, sdk, startedAt, now, ec2, keyId, phase, waitingFor, status: ap?.status() ?? null, healthz: ap?.healthz() ?? null, applies, renders, exportInfo, probe, log });
 * await s3.send(new PutObjectCommand({ Bucket, Key: "status/airgap.json", Body: JSON.stringify(doc) }));
 * ```
 */
import type { AgentStatus, BundleOutcome, Healthz } from "@airprompter/agent-sdk";

export const AIRGAP_STATUS_KIND = "airprompter-airgap-status" as const;
/** How many apply outcomes and log lines the document carries (the newest). */
export const STATUS_APPLIES_KEPT = 20;
export const STATUS_LOG_KEPT = 30;

export type AirgapPhase = "awaiting_key" | "awaiting_bundle" | "serving";

export interface ApplyRecord {
  at: string;
  generation: number | null;
  outcome: BundleOutcome["outcome"];
  reason: string | null;
  detail: string | null;
  /** `vendored`: the bundle the host started on; `exchange`: handed to `applyBundle()` from the bucket. */
  source: "vendored" | "exchange";
  object: string | null;
}

export interface RenderInfo {
  count: number;
  lastAt: string | null;
  last: { tag: string; versionId: string; arm: string; model: string; subject: string } | null;
  /** What the host files for each render: `refused` — it has no route to any model and says so, never a made-up answer. */
  observation: "refused";
}

export interface ExportInfo {
  at: string;
  segments: number;
  bytes: number;
  instances: number;
  object: string | null;
  generation: number;
}

export interface ProbeInfo {
  at: string;
  curl: { url: string; exit: number; seconds: number; meaning: string };
  dns: { name: string; resolved: boolean; detail: string };
}

export interface AirgapStatusDoc {
  kind: typeof AIRGAP_STATUS_KIND;
  v: 1;
  hostId: string;
  region: string;
  sdk: string;
  writtenAt: string;
  startedAt: string;
  /** Monotonic per process, so a reader can tell a rewrite from a stale copy. */
  seq: number;
  ec2: { instanceId: string; availabilityZone: string } | null;
  /** The id of the distribution key born on this host (its public half is in the exchange); null before keygen. */
  keyId: string | null;
  phase: AirgapPhase;
  /** While waiting: the newest row the table holds and which key it is sealed to, so the card can say why. */
  waitingFor: { newest: { generation: number; keyId: string | null } | null } | null;
  status: AgentStatus | null;
  healthz: Healthz | null;
  applies: ApplyRecord[];
  renders: RenderInfo;
  export: ExportInfo | null;
  probe: ProbeInfo | null;
  log: Array<Record<string, unknown>>;
}

export function buildStatusDoc(input: Omit<AirgapStatusDoc, "kind" | "v" | "seq" | "writtenAt"> & { now: string; seq: number }): AirgapStatusDoc {
  const { now, seq, ...rest } = input;
  return {
    kind: AIRGAP_STATUS_KIND,
    v: 1,
    ...rest,
    writtenAt: now,
    seq,
    applies: rest.applies.slice(-STATUS_APPLIES_KEPT),
    log: rest.log.slice(-STATUS_LOG_KEPT),
  };
}

/** A parsed document, or null when the bytes are not one (a reader never trusts the bucket's shape blindly). */
export function parseStatusDoc(text: string): AirgapStatusDoc | null {
  try {
    const doc = JSON.parse(text) as Partial<AirgapStatusDoc>;
    if (doc.kind !== AIRGAP_STATUS_KIND || doc.v !== 1 || typeof doc.hostId !== "string" || typeof doc.writtenAt !== "string" || typeof doc.startedAt !== "string" || !Array.isArray(doc.applies)) return null;
    return doc as AirgapStatusDoc;
  } catch {
    return null;
  }
}
