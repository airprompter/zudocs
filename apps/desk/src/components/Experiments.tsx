/**
 * Saved A/B scorecards with the full measurements behind a side panel.
 * These are local records in a stated time window, not platform receipts.
 * @example
 * <Experiments arms={arms} />
 */
import { useState } from "react";
import type { ArmSummary, Arms } from "../api";
import { ago, armLabel, latency, modelLabel, money, slotShort } from "../format";
import { Fold } from "./Fold";
import { SlideOut } from "./SlideOut";

export function Experiments({ arms }: { arms: Arms | null }) {
  const [picked, setPicked] = useState<ArmSummary | null>(null);
  if (!arms) return <p className="muted">Reading saved scorecards…</p>;
  const rows = arms.arms.filter((a) => a.arm !== "none");
  const paired = arms.stickiness.filter((s) => Object.keys(s.arms).length > 1);
  return <section className="evidence-page">
    <section className="record-list"><div className="record-list-head"><h2>Saved A/B scorecards</h2><span className="fine muted">read {ago(arms.readAt)}</span></div><div className="evidence-padding"><p className="fine muted">Last 24 hours · {arms.runsRead} saved runs across hosts and releases. Historical groups are shown even after a test ends; these are not scoped to one experiment.</p>{arms.ramps.map((r) => <div key={r.experimentId} className="mix"><p className="fine"><strong>{r.tag ? slotShort(r.tag) : "Reply"}</strong> · US host's live weights: {r.arms.map((a,i)=>`${armLabel(a)} ${(r.weightBps[i]??0)/100}%`).join(" · ")}</p><Fold title="Scheduled percentage changes"><p className="fine">{r.plan.map((p,i)=>`${i===r.step?'Now: ':''}${p.weightBps.map((bps,j)=>`${r.arms[j]} ${bps/100}%`).join(' · ')} at ${p.notBefore}`).join(' → ')}</p>{r.nextStepAt ? <p className="fine muted">Next scheduled step {r.nextStepAt}.</p> : null}</Fold></div>)}</div>
      {rows.length ? rows.map((a)=><button type="button" className="record-row" key={`${a.tag}|${a.arm}|${a.versionId}|${a.model}`} onClick={()=>setPicked(a)}><span><strong>{slotShort(a.tag)} · {armLabel(a.arm)} · {a.versionId}</strong><small>{a.runs} runs · {a.judgeMean === null ? "quality unreported" : `${Math.round(a.judgeMean*100)}% mean quality`} · {money(a.costMeanUsd)} / run</small></span><span className="record-open">Inspect →</span></button>) : <p className="empty muted">No saved A/B assignments in this window. Publish a test in AirPrompter, then run a small real batch.</p>}
    </section>
    {paired.length ? <Fold title="Customer assignment across hosts"><p className="fine">{paired.filter((s)=>!s.consistent).length} disagreement(s) among {paired.length} comparable customer / prompt / release rows. Different releases are checked separately because dial changes can move a customer.</p><div className="scroll-x"><table className="evidence-table"><thead><tr><th>Customer</th><th>Prompt / release</th><th>Host assignments</th></tr></thead><tbody>{paired.slice(0,30).map((s)=><tr key={`${s.customerId}|${s.tag}|${s.generation}`}><td>{s.customerId}</td><td>{slotShort(s.tag)} · #{s.generation??"—"}</td><td>{Object.entries(s.arms).map(([h,a])=>`${h}: ${a}`).join(' · ')}</td></tr>)}</tbody></table></div></Fold> : null}
    {picked ? <SlideOut title={`${slotShort(picked.tag)}: ${armLabel(picked.arm)}`} onClose={()=>setPicked(null)}><dl className="integration-settings"><div><dt>Version</dt><dd>{picked.versionId}</dd></div><div><dt>Model</dt><dd>{modelLabel(picked.model)}</dd></div><div><dt>Saved runs</dt><dd>{picked.runs}</dd></div><div><dt>Mean quality</dt><dd>{picked.judgeMean===null?'Unreported':`${Math.round(picked.judgeMean*100)}% across ${picked.judged} judged runs`}</dd></div><div><dt>Mean cost</dt><dd>{money(picked.costMeanUsd)} across {picked.costed} costed runs</dd></div><div><dt>Mean latency</dt><dd>{latency(picked.latencyMeanMs)}</dd></div><div><dt>Checks</dt><dd>{picked.checksPassed} pass · {picked.checksFailed} fail</dd></div><div><dt>Errors</dt><dd>{picked.errors}</dd></div><div><dt>Thumbs</dt><dd>{picked.feedback.up} up · {picked.feedback.down} down</dd></div><div><dt>Accepted / edited</dt><dd>{picked.feedback.accepted} / {picked.feedback.edited}</dd></div></dl><Fold title="Runs by host"><dl className="integration-settings">{Object.entries(picked.hosts).map(([h,n])=><div key={h}><dt>{h}</dt><dd>{n}</dd></div>)}</dl></Fold></SlideOut> : null}
  </section>;
}
