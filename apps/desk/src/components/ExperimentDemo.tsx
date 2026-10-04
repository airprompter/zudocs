/**
 * Free sticky-assignment previews and bounded real traffic, kept distinct.
 * The preview dial never writes AirPrompter weights or production measurements.
 * @example
 * <ExperimentDemo api={api} state={state} busy={busy} onAction={act} />
 */
import { useState } from "react";
import type { Api, AssignmentPreview, State } from "../api";
import { Fold } from "./Fold";
import { RolloutStatus } from "./RolloutStatus";
import { SlideOut } from "./SlideOut";

export function ExperimentDemo({ api, state, busy, onAction, boardUrl }: { api: Api; state: State | null; busy: string | null; onAction: (action: string, body?: Record<string, unknown>) => void; boardUrl?: string }) {
  const [percentage, setPercentage] = useState(10);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [batch, setBatch] = useState(5);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const check = async (live: boolean) => {
    setReading(true); setError(null); setPreview(null);
    try { setPreview(await api.preview(live ? undefined : percentage)); }
    catch { setError("The preview could not be read. The published release may be unavailable or its experiment may not support a two-group preview."); }
    finally { setReading(false); }
  };
  const active = Array.isArray(state?.host.status.ramps) && state!.host.status.ramps.some((r) => !r.tag || r.tag === "support.reply");
  const blocked = busy !== null || !state || state.frozen?.frozen || state.cap.used >= state.cap.cap;
  return <section className="evidence-page">
    <header className="page-heading"><div><h2 className="section-title">Rollout and experiments</h2><p className="muted">Observe AirPrompter’s live plan and test the resulting replies.</p></div>{boardUrl ? <a className="external-link" href={boardUrl} target="_blank" rel="noreferrer">Manage in AirPrompter ↗</a> : null}</header>
    <RolloutStatus api={api} state={state} />
    <Fold title="Simulate assignments · no live changes"><div className="demo-card"><label className="preview-dial">Preview candidate share <strong>{percentage}%</strong><input type="range" disabled={reading} aria-label="Preview candidate share" min="0" max="100" step="5" value={percentage} onChange={(e) => { setPercentage(Number(e.target.value)); setPreview(null); setError(null); }} /></label><div className="button-row"><button type="button" className="button secondary" disabled={reading} onClick={() => void check(false)}>Preview {percentage}%</button><button type="button" className="chip-button" disabled={reading} onClick={() => void check(true)}>Check published assignment</button></div><p className="fine muted">100 fixed simulated visitors. No model calls, saved runs, telemetry or live rollout changes. Publish live weights in AirPrompter; hosts pull the signed release under their own policy.</p>
      {reading ? <p role="status" className="muted">Reading the verified release…</p> : null}{error ? <p role="status" className="problem">{error}</p> : null}
      {preview ? <div className="preview-result"><p><strong>{preview.mode === "published" ? "Published assignment" : preview.mode === "illustration" ? "Illustration · no live reply experiment" : "What-if assignment · live weights unchanged"}</strong> · release #{preview.generation}</p><p className="fine">Configured share: {preview.weights.map((w) => `${w.arm === "none" ? "published" : w.arm} ${w.weightBps/100}%`).join(" · ")}</p><div className="visitor-grid" aria-label="100 simulated visitor assignments">{preview.rows.map((r) => <span key={r.visitor} className={`visitor visitor-${r.arm === "candidate" ? "candidate" : r.arm === "refused" ? "refused" : "control"}`} title={`${r.visitor}: ${r.arm}`} />)}</div><p className="fine">Observed sample: {Object.entries(preview.counts).map(([a,n])=>`${a === "none" ? "published" : a}: ${n}`).join(" · ")}. A small sample can differ from the configured percentages.</p><button type="button" className="link" onClick={()=>setExpanded(true)}>Inspect visitor assignments</button></div> : null}
    </div></Fold>
    <Fold title="Run real demo traffic"><p className="fine muted">{active ? "A reply experiment is active on the US desk." : "No reply A/B experiment is active on the US desk. These runs use the published version until an experiment is published."} Each ticket uses the same customer ID across hosts. Repeating a customer keeps its assignment within the same signed experiment and weights.</p><div className="button-row"><label className="control-select">Batch size<select value={batch} onChange={(e)=>setBatch(Number(e.target.value))}>{[5,12,30].map((n)=><option key={n} value={n}>{n} replies</option>)}</select></label><button type="button" className="button secondary" disabled={!!blocked} onClick={()=>{setRequestedAt(new Date().toISOString());onAction("replay",{n:batch});}}>Run {batch} real replies</button></div><p className="fine muted">Bedrock model calls, saved records and real metrics · {state ? `${state.cap.used} / ${state.cap.cap} runs used today` : "Reading daily limit"}. Batches run in the background under the existing cap and freeze switch.</p>{requestedAt ? <p className="storage-note">Requested at {requestedAt}. The saved scorecard below updates as replies finish; a request is not a completion receipt.</p> : null}{state?.features?.demoMode ? <div className="button-row"><span className="fine muted">Europe automatic traffic: {state.demoMode?.mode ?? "unreported"}{state.demoMode?.until ? ` until ${state.demoMode.until}` : ""}</span><button type="button" className="chip-button" disabled={!!blocked || state.demoMode?.mode === "on"} onClick={()=>onAction("demo_mode",{value:"on"})}>Start Europe demo traffic</button><button type="button" className="chip-button" disabled={busy !== null || state.demoMode?.mode !== "on"} onClick={()=>onAction("demo_mode",{value:"off"})}>Stop Europe demo traffic</button></div> : null}<p className="fine muted">Europe runs one Node ticket every two minutes and one Python ticket every five minutes while demo mode is on, for at most four hours. The SDK applies published releases automatically; no Zudocs release action is needed.</p></Fold>
    {expanded && preview ? <SlideOut title="Simulated visitor assignments" onClose={()=>setExpanded(false)}><p className="fine muted">{preview.mode} preview · #{preview.generation} · checked {preview.checkedAt}. Fixed visitor IDs and the SDK assignment rule make repeats stable.</p><table className="evidence-table"><thead><tr><th>Visitor</th><th>Group</th></tr></thead><tbody>{preview.rows.map((r)=><tr key={r.visitor}><td>{r.visitor}</td><td>{r.arm}</td></tr>)}</tbody></table></SlideOut> : null}
  </section>;
}
