/**
 * The selected host's release, rollout and saved reply settings, without prompt bodies.
 * Host reports describe local state; desk records prove which version actually answered.
 * @example
 * <IntegrationStatus host={host} runs={runs} />
 */
import { isHostedRun, type AnyRun, type HostStatus, type Ramp } from "../api";
import { ago, armLabel, clock, effectiveApplyState, modelLabel } from "../format";
import { Fold } from "./Fold";

export function integrationSnapshot(host: HostStatus, runs: AnyRun[]) {
  const generation = Number(host.status.generation ?? 0);
  const saved = [...runs].filter((run) => !isHostedRun(run) && run.kind === "run" && run.host === host.hostId)
    .sort((a, b) => b.at.localeCompare(a.at))
    .flatMap((run) => {
      if (isHostedRun(run)) return [];
      const reply = run.steps.find((step) => step.step === "reply");
      return reply ? [{ run, reply }] : [];
    });
  const current = saved.find(({ reply }) => reply.generation === generation) ?? null;
  const ramps: Ramp[] | null = Array.isArray(host.status.ramps)
    ? host.status.ramps.filter((r: Ramp) => !r.tag || r.tag === "support.reply") : null;
  return { generation, current, latest: saved[0] ?? null, ramps };
}

export function settingLabel(key: string, value: unknown): { label: string; value: string } {
  if (key === "temperatureMilli" && typeof value === "number") return { label: "Temperature", value: String(value / 1000) };
  if (key === "topPMilli" && typeof value === "number") return { label: "Top-p", value: String(value / 1000) };
  const labels: Record<string, string> = { maxOutputTokens: "Max output tokens", temperature: "Temperature", topP: "Top-p", reasoningEffort: "Reasoning effort", stop: "Stop sequences" };
  return { label: labels[key] ?? key.replace(/([A-Z])/g, " $1"), value: Array.isArray(value) ? value.join(" · ") : String(value) };
}

export function IntegrationStatus({ host, runs }: { host: HostStatus; runs: AnyRun[] }) {
  const { generation, current, latest, ramps } = integrationSnapshot(host, runs);
  const active = effectiveApplyState(host.status) === "active";
  const settings = current?.reply.rendered?.inference;
  return <div className="integration-status" aria-label="AirPrompter status and settings">
    <section>
      <h3>Prompt in Zudocs</h3>
      <p><strong>Release #{generation || "—"} · {active ? "active locally" : effectiveApplyState(host.status) ?? "state unreported"}</strong></p>
      <p>Last release check: {host.status.lastSyncAt ? `${clock(host.status.lastSyncAt)} · ${ago(host.status.lastSyncAt)}` : "not reported"}. Result: {host.status.lastSyncOutcome ?? "not reported"}.</p>
      <p>{latest ? <>Desk database: saved reply {latest.reply.versionId ?? "version unreported"} from release #{latest.reply.generation ?? "—"} at {clock(latest.run.at)}{latest.reply.generation !== generation ? " · this is an earlier release" : ""}.</> : "Desk database: no reply recorded for this ticket on this host."}</p>
      <Fold title="Where Zudocs stores this">
        <p>{host.status.source === "store" ? "Loaded from the SDK’s local release cache." : `Release source: ${host.status.source ?? "not reported"}.`} Cache protection: {host.status.storageProtection === "kms" ? "encrypted; key protected by KMS" : host.status.storageProtection ?? "not reported"}.</p>
        <p className="muted fine">The SDK stores the release locally. The desk database stores reply records and host reports, including the version and settings used. This report does not independently read the latest AirPrompter release.</p>
      </Fold>
    </section>
    <section>
      <h3>Reply rollout</h3>
      {ramps === null ? <p>Rollout not reported by this host.</p> : ramps.length === 0 ? <><p><strong>100% published version</strong></p><p>A/B test off on this host’s active release.</p></> : ramps.map((r) => <div key={r.experimentId}>
        <p><strong>{r.arms.map((arm, i) => `${armLabel(arm)} ${((r.weightBps[i] ?? 0) / 100).toLocaleString()}%`).join(" · ")}</strong></p>
        {r.plan.length && r.arms.includes("candidate") ? <p>Scheduled dial: {r.plan.map((p) => `${((p.weightBps[r.arms.indexOf("candidate")] ?? 0) / 100).toLocaleString()}%`).join(" → ")} new reply.</p> : null}
        {r.nextStepAt ? <p>Next step: {clock(r.nextStepAt)} · {new Date(r.nextStepAt).toLocaleDateString()}.</p> : null}
      </div>)}
      {current ? <p>This ticket’s saved reply: {current.reply.arm && current.reply.arm !== "none" ? `${armLabel(current.reply.arm)} group` : "published version"}, {current.reply.versionId ?? "version unreported"}.</p> : <p>Draft a reply to record this ticket’s assignment on release #{generation}.</p>}
      <p className="muted fine">Percentages come from this host’s active release. Customer assignment is recorded with the reply.</p>
    </section>
    <section>
      <h3>Settings used for this reply</h3>
      {current ? <>
        <p><strong>{current.reply.model ? modelLabel(current.reply.model) : "Model unreported"}</strong> · {current.reply.versionId ?? "version unreported"}</p>
        {settings && Object.keys(settings).length ? <dl className="integration-settings">{Object.entries(settings).map(([key, value]) => {
          const setting = settingLabel(key, value);
          return <div key={key}><dt>{setting.label}</dt><dd>{setting.value}</dd></div>;
        })}</dl> : <p>No explicit model settings recorded.</p>}
        {current.reply.provider ? <p>Direct provider: {current.reply.provider.name}. Applied: {Object.entries(current.reply.provider.applied).map(([key, value]) => `${key} ${value}`).join(" · ") || "model defaults"}.{current.reply.provider.ignored.length ? ` Ignored: ${current.reply.provider.ignored.join(", ")}.` : ""}</p> : null}
        <p className="muted fine">Recorded with this reply at {clock(current.run.at)}. Settings for an unrun version are not inferred.</p>
      </> : <p>No reply settings recorded yet for release #{generation} on this host. Draft a reply to see the version and settings actually used.</p>}
    </section>
  </div>;
}
