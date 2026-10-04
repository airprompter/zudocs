/**
 * AirPrompter's independently verified published plan beside each host's SDK cache report.
 * All release decisions belong to AirPrompter; this view has no release mutation controls.
 * @example
 * <RolloutStatus api={api} state={state} boardUrl={boardUrl} />
 */
import { useEffect, useState } from "react";
import type { Api, PublishedRollout, State } from "../api";
import { ago } from "../format";
import { settingLabel } from "./IntegrationStatus";
import { Fold } from "./Fold";

const share = (weights: Array<{ arm: string; weightBps: number }>) => weights.map((w) => `${w.arm === "none" ? "Published version" : w.arm} ${w.weightBps / 100}%`).join(" · ");

export function RolloutStatus({ api, state, boardUrl }: { api: Api; state: State | null; boardUrl?: string }) {
  const [published, setPublished] = useState<PublishedRollout | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try { const value = await api.rollout(); if (alive) { setPublished(value); setFailed(false); } }
      catch { if (alive) setFailed(true); }
      finally { if (alive) timer = setTimeout(() => void read(), 20_000); }
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [api]);
  const reports = state?.hosts.filter((h) => h.kind !== "puller").sort((a,b) => ({lambda:0,daemon:1,airgapped:2}[a.kind as "lambda" | "daemon" | "airgapped"] ?? 3) - ({lambda:0,daemon:1,airgapped:2}[b.kind as "lambda" | "daemon" | "airgapped"] ?? 3)).map((h) => ({ label: h.kind === "lambda" ? "US support desk" : h.kind === "daemon" ? "Europe · Node" : "Offline host", at: h.writtenAt, status: h.status, live: h.reportSource === "live" })) ?? [];
  const europe = state?.hosts.find((h) => h.kind === "daemon");
  if (europe?.python) reports.splice(2, 0, { label: "Europe · Python", at: europe.python.writtenAt, status: europe.python, live: false });
  return <section className="demo-card" aria-label="AirPrompter rollout">
    <header className="page-heading"><div><p className="eyebrow">Managed in AirPrompter</p><h2 className="section-title">Published → synced → used</h2></div>{boardUrl ? <a className="external-link" href={boardUrl} target="_blank" rel="noreferrer">Open AirPrompter ↗</a> : null}</header>
    <p className="muted">Approve releases and set A/B percentages in AirPrompter. Zudocs verifies and syncs the signed release automatically. The SDK assigns customers locally; every reply saves the version and group it used.</p>
    {failed ? <p className="problem">AirPrompter could not be refreshed. {published ? `Showing the last verified plan from ${published.checkedAt}; sync comparisons are unconfirmed.` : "The published plan is unavailable."}</p> : null}
    {published ? <>
      <div className="integration-summary"><strong>AirPrompter · release #{published.generation}</strong><span>{published.disabled ? "Reply disabled by the published release" : share(published.weights)}</span></div>
      <p className="fine muted">{published.experimentId ? `Live reply test · ${published.experimentId}` : "No live reply A/B test published"} · {state?.airprompter.environment ?? ""} · verified {ago(published.checkedAt)}{published.nextStepAt ? ` · next scheduled change ${new Date(published.nextStepAt).toLocaleString()}` : ""}</p>
      <table className="evidence-table"><thead><tr><th>Zudocs host</th><th>SDK release</th><th>Local percentage</th><th>Sync evidence</th></tr></thead><tbody>{reports.map((r) => {
        const reportAt = Date.parse(r.at);
        const old = !Number.isFinite(reportAt) || Date.now() - reportAt > 120_000;
        const sameGeneration = r.status.generation === published.generation;
        const digest = r.status.releaseDigest;
        const match = sameGeneration && digest === published.releaseDigest;
        const ramp = Array.isArray(r.status.ramps) ? r.status.ramps.find((x: any) => !x.tag || x.tag === "support.reply") : null;
        const localWeights = ramp?.arms.map((arm: string, i: number) => ({arm, weightBps:ramp.weightBps[i]})) ?? [];
        const dialMatches = ramp && ramp.experimentId === published.experimentId && localWeights.length === published.weights.length && localWeights.every((w: {arm:string;weightBps:number}) => published.weights.some(p => p.arm === w.arm && p.weightBps === w.weightBps));
        const localShare = ramp ? share(localWeights) : Array.isArray(r.status.ramps) && !published.experimentId && match ? (published.disabled ? "Reply disabled" : "Published version 100%") : "Unreported";
        return <tr key={r.label}><td>{r.label}<small className="muted"> · {ago(r.at)}</small></td><td>#{r.status.generation ?? "—"}</td><td>{localShare}</td><td>{failed || old ? "Unconfirmed · old report" : match ? published.experimentId && !dialMatches ? "Release matches · dial unconfirmed or different" : "Signed release matches" : sameGeneration && !digest ? "Generation matches · digest unreported" : "Waiting for sync"}{r.status.stagedGeneration ? ` · #${r.status.stagedGeneration} staged (${r.status.applyState})` : ""}</td></tr>;
      })}</tbody></table>
      <Fold title="Published plan and local percentages"><p className="fine muted">The release is stored in each SDK's local cache. Zudocs's database stores host reports and reply evidence; it does not author rollout weights. Scheduled steps are evaluated by the SDK's clock from the signed plan, including while disconnected.</p><dl className="integration-settings"><div><dt>Published policy</dt><dd>{published.applyPolicy}</dd></div><div><dt>Assignment key</dt><dd>{published.subjectKey === "request" ? "Customer ID" : published.subjectKey ?? "No experiment"}</dd></div><div><dt>Release digest</dt><dd className="mono">{published.releaseDigest}</dd></div></dl>{published.weights.map((w) => <p className="fine" key={w.arm}>{w.arm === "none" ? "Published" : w.arm} · {w.versionId} · {w.model} · {w.weightBps/100}%{Object.entries(w.inference ?? {}).map(([k,v]) => { const setting = settingLabel(k,v); return <span key={k}> · {setting.label}: {setting.value}</span>; })}</p>)}{published.plan.length ? <table className="evidence-table"><thead><tr><th>AirPrompter schedule</th><th>Shares</th></tr></thead><tbody>{published.plan.map((s) => <tr key={s.notBefore}><td>{new Date(s.notBefore).toLocaleString()}</td><td>{s.weightBps.map((w,i) => `${published.weights[i]?.arm ?? `Group ${i+1}`} ${w/100}%`).join(" · ")}</td></tr>)}</tbody></table> : null}{reports.map((r) => <p className="fine" key={r.label}><strong>{r.label}</strong> · {Array.isArray(r.status.ramps) && r.status.ramps.filter((x: any) => !x.tag || x.tag === "support.reply").length ? r.status.ramps.filter((x: any) => !x.tag || x.tag === "support.reply").map((x: any) => x.arms.map((arm: string,i: number) => `${arm} ${x.weightBps[i]/100}%`).join(" · ")).join("; ") : "No reply test percentages reported"} · policy {r.status.applyPolicy?.effective ?? "unreported"}</p>)}</Fold>
    </> : !failed ? <p role="status" className="muted">Reading the signed AirPrompter release…</p> : null}
  </section>;
}
