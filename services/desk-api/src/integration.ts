/**
 * Read-only release evidence and assignment previews using the public SDK.
 * Independent origin reads verify the signature chain and payloads; previews
 * never observe a model call, enqueue traffic, or write database records.
 * @example
 * const view = compareRun(saved, published, Date.now());
 */
import { createHash, randomBytes } from "node:crypto";
import { assignArm, BundleRelease, generateX25519KeyPair, pullBundle, ReleaseResolver, SyncClient, trustedRootFromPinnedKey, type LoadedRelease, type RootMetadata, type Target } from "@airprompter/agent-sdk";
import type { DeskEnv } from "./env.js";
import type { RunRecord } from "./run.js";

export function publishedReader(config: DeskEnv["airprompter"], apiKey: string, fetchImpl: typeof fetch = fetch) {
  const target = config.environment as Target;
  const scope = { organizationId: config.organizationId, agentId: config.agentId, target };
  const client = new SyncClient({ baseUrl: config.baseUrl, agentId: config.agentId, target, apiKey, fetch: fetchImpl as never });
  let trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: config.hostedEnvironment as Target, pinnedRoot: JSON.parse(config.rootJwk) });
  const recipient = generateX25519KeyPair();
  let held: LoadedRelease | null = null;
  let edge: Parameters<typeof pullBundle>[0]["edge"] = null;
  let pending: Promise<LoadedRelease> | null = null;
  return (): Promise<LoadedRelease> => {
    if (pending) return pending;
    pending = (async () => {
      const result = await pullBundle({ client, scope, trustedRoot, distributionPublicKey: recipient.publicRaw, minimumGeneration: held?.generation ?? 0, edge, skipPointer: true, now: () => new Date().toISOString(), fetchRoot: async () => {
        const response = await fetchImpl(config.rootUrl, { signal: AbortSignal.timeout(10000) });
        return response.status === 200 ? JSON.parse(await response.text()) as RootMetadata : null;
      } });
      if (result.status === "unchanged" && held) { edge = result.edge; return held; }
      if (result.status !== "ok") throw new Error(`published_release_${result.status}${"reason" in result ? `_${result.reason}` : ""}`);
      const loaded = BundleRelease.load({ bundle: result.bundle, root: result.trustedRoot, scope, now: new Date().toISOString(), distributionKey: recipient });
      if (!loaded.ok) throw new Error(`published_release_${loaded.reason}`);
      held = loaded.release.current();
      trustedRoot = result.trustedRoot;
      edge = result.edge;
      return held;
    })().finally(() => { pending = null; });
    return pending;
  };
}

function resolver(release: LoadedRelease, nowMs: number) {
  const p = release.manifest.payload;
  return new ReleaseResolver({ release, runRefKey: randomBytes(32), agentId: p.agentId, target: p.target, instanceId: "zudocs-read-only-preview", nowMs: () => nowMs });
}
const same = (a: unknown, b: unknown): boolean => {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)])) : value;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};

export function compareRun(run: RunRecord, release: LoadedRelease, nowMs: number) {
  const runtime = resolver(release, nowMs);
  return { runId: run.runId, checkedAt: new Date(nowMs).toISOString(), generation: release.generation, releaseDigest: release.manifest.payload.releaseDigest,
    steps: run.steps.map((saved) => {
      const base = { step: saved.step, tag: saved.tag, saved: { generation: saved.generation, versionId: saved.versionId, arm: saved.arm, model: saved.model, inference: saved.rendered?.inference ?? null } };
      if (runtime.experimentFor(saved.tag)?.subjectKey === "instance") return { ...base, current: null, text: null, matches: null, reason: "original_instance_not_recorded" };
      const resolved = runtime.resolve(saved.tag, run.customerId);
      if (!resolved.ok) return { ...base, current: null, text: null, matches: null, reason: resolved.reason };
      const current = { generation: release.generation, versionId: resolved.slot.versionId, arm: resolved.arm, model: resolved.slot.model, inference: resolved.slot.inference ?? null };
      // Reuse the values recorded on the saved run; new required variables refuse
      // rather than silently substituting today's database values.
      let text: string | null = null;
      let reason: string | null = null;
      if (saved.rendered) {
        try {
          text = runtime.render(resolved, Object.fromEntries(saved.rendered.variables.filter((v) => v.value !== null && resolved.slot.variables.some((declared) => declared.name === v.name)).map((v) => [v.name, v.value])), { fenced: new Set(saved.rendered.variables.filter((v) => v.fenced).map((v) => v.name)) }).text;
        } catch { reason = "saved_variables_insufficient"; }
      } else reason = "no_saved_render";
      return { ...base, current, text, reason, matches: { version: saved.versionId === current.versionId, generation: saved.generation === current.generation, arm: saved.arm === current.arm, model: saved.model === current.model, settings: same(base.saved.inference, current.inference), prompt: text === null ? null : text === saved.rendered?.text } };
    }) };
}

/** Fixed synthetic visitors use the SDK's sticky assignment; no fake runs or metrics. */
export function previewAssignments(release: LoadedRelease, pct: number | null, nowMs: number) {
  const runtime = resolver(release, nowMs);
  const experiment = runtime.experimentFor("support.reply");
  const active = runtime.arms("support.reply");
  const candidate = active?.findIndex((a) => a.arm === "candidate") ?? -1;
  const live = pct === null;
  if (live && experiment && !active) return { error: "reply_disabled" };
  if (!live && (!Number.isInteger(pct) || pct! < 0 || pct! > 100)) return { error: "invalid_percentage" };
  if (!live && experiment && (active?.length !== 2 || candidate < 0)) return { error: "preview_requires_two_arms" };
  if (!live && experiment?.subjectKey === "instance") return { error: "preview_requires_request_assignment" };
  const weights = live ? active?.map(({ arm, weightBps }) => ({ arm, weightBps })) ?? [{ arm: "none", weightBps: 10000 }]
    : [{ arm: "control", weightBps: (100 - pct!) * 100 }, { arm: "candidate", weightBps: pct! * 100 }];
  const salt = experiment?.salt ?? createHash("sha256").update(`${release.manifest.payload.agentId}:illustrative-preview`).digest("base64url");
  const rows = Array.from({ length: 100 }, (_, i) => {
    const visitor = `demo-visitor-${String(i + 1).padStart(3, "0")}`;
    const assignment = live ? runtime.resolve("support.reply", visitor) : { ok: true as const, arm: assignArm({ salt, subject: visitor, arms: weights }).arm.arm };
    return { visitor, arm: assignment.ok ? assignment.arm : "refused" };
  });
  return { checkedAt: new Date(nowMs).toISOString(), generation: release.generation, experimentId: experiment?.experimentId ?? null, mode: live ? "published" : experiment ? "what_if" : "illustration", weights, rows,
    counts: Object.fromEntries([...new Set(rows.map((r) => r.arm))].map((arm) => [arm, rows.filter((r) => r.arm === arm).length])) };
}

/** Only metadata from the independently verified AirPrompter release; never payloads or experiment salts. */
export function publishedRollout(release: LoadedRelease, nowMs: number) {
  const runtime = resolver(release, nowMs);
  const experiment = runtime.experimentFor("support.reply");
  const resolved = runtime.resolve("support.reply", "zudocs-rollout-status");
  const arms = runtime.arms("support.reply");
  const plan = experiment?.ramp ?? [];
  const slot = release.manifest.payload.slots.find((s) => s.tag === "support.reply");
  return {
    checkedAt: new Date(nowMs).toISOString(), generation: release.generation,
    releaseDigest: release.manifest.payload.releaseDigest, applyPolicy: release.manifest.payload.applyPolicy,
    tag: "support.reply", experimentId: experiment?.experimentId ?? null, subjectKey: experiment?.subjectKey ?? null,
    disabled: !resolved.ok, nextStepAt: plan.find((s) => Date.parse(s.notBefore) > nowMs)?.notBefore ?? null,
    plan: plan.map((s) => ({ notBefore: s.notBefore, weightBps: s.weightBps })),
    weights: experiment ? (arms ?? []).map((a) => {
      const version = a.overrides.find((s) => s.tag === "support.reply") ?? slot;
      return { arm: a.arm, weightBps: a.weightBps, versionId: version?.versionId ?? null, model: version?.model ?? null, inference: version?.inference ?? null };
    }) : resolved.ok ? [{ arm: "none", weightBps: 10000, versionId: resolved.slot.versionId, model: resolved.slot.model, inference: resolved.slot.inference ?? null }] : [],
  };
}
