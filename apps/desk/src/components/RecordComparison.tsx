/**
 * Compare a persisted run with an independent verified AirPrompter release.
 * The SDK re-renders using saved variable values; model calls stay out of reads.
 * @example
 * <RecordComparison api={api} runs={runs} ticketId={id} boardUrl={url} />
 */
import { useEffect, useState } from "react";
import { isHostedRun, type AnyRun, type Api, type Ticket, type RecordComparison as Comparison } from "../api";
import { ago, armLabel, modelLabel } from "../format";
import { deskHref } from "../route";
import { recordTime } from "./Database";
import { Fold } from "./Fold";
import { ReplyText } from "./ReplyText";
import { SlideOut } from "./SlideOut";
import { settingLabel } from "./IntegrationStatus";

export function DatabaseNav({ compare, ticketId }: { compare: boolean; ticketId: string | null }) {
  return <nav className="section-nav" aria-label="Database pages"><a href={deskHref("database", ticketId)} aria-current={!compare ? "page" : undefined}>Records</a><a href={deskHref("compare", ticketId)} aria-current={compare ? "page" : undefined}>Compare with AirPrompter</a></nav>;
}
const settings = (v: Record<string, unknown> | null) => v && Object.keys(v).length ? Object.entries(v).map(([k, v]) => { const row = settingLabel(k, v); return `${row.label}: ${row.value}`; }).join(" · ") : "No explicit settings";

export function RecordComparison({ api, runs, ticketId, boardUrl, ready, tickets, onSelect }: { api: Api; runs: AnyRun[]; ticketId: string | null; boardUrl?: string; ready: boolean; tickets: Ticket[]; onSelect: (id: string) => void }) {
  const records = (ready ? [...runs] : []).filter((r) => !isHostedRun(r)).sort((a, b) => b.at.localeCompare(a.at));
  const [selected, setSelected] = useState<string | null>(null);
  const run = records.find((r) => r.runId === selected) ?? records[0] ?? null;
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [step, setStep] = useState<string | null>(null);
  useEffect(() => {
    setComparison(null); setError(null); setStep(null); setReading(false);
    if (!run) return;
    let current = true;
    setReading(true);
    api.comparison(run.runId).then((value) => { if (current) setComparison(value); }).catch(() => { if (current) setError("The published release could not be verified. Your saved records are still available."); }).finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [api, run?.runId, refresh]);
  const inspected = comparison?.steps.find((s) => s.step === step);
  const savedStep = run && !isHostedRun(run) ? run.steps.find((s) => s.step === step) : null;
  return <div className="page-content">
    <header className="page-heading"><div><p className="eyebrow">Zudocs records</p><h1>Database</h1><p className="muted">Compare what answered with what AirPrompter publishes now.</p></div></header>
    <DatabaseNav compare ticketId={ticketId} />
    <div className="database-tools"><label>Ticket<select value={ticketId ?? ""} onChange={(e) => onSelect(e.target.value)}>{tickets.map((t) => <option key={t.ticketId} value={t.ticketId}>{t.ticketId} · {t.customer?.name ?? t.customerId}</option>)}</select></label><label>Saved run<select value={run?.runId ?? ""} onChange={(e) => setSelected(e.target.value)}>{records.map((r) => <option key={r.runId} value={r.runId}>{recordTime(r.at)} · {r.host}</option>)}</select></label><button type="button" className="chip-button" disabled={!run || reading} onClick={() => setRefresh((n) => n + 1)}>Check published release</button>{boardUrl ? <a className="external-link" href={boardUrl} target="_blank" rel="noreferrer">Open AirPrompter ↗</a> : null}</div>
    <p className="fine muted">Up to 10 latest runs for {ticketId ?? "the selected ticket"}. The published release is read independently from AirPrompter and verified by the SDK. Saved variable values are reused; no model is called.</p>
    {!ready ? <p className="muted">Reading saved records…</p> : !run ? <p className="muted">No comparable saved run for this ticket. Draft a reply in Inbox first.</p> : null}
    {error ? <p className="problem" role="status">{error}</p> : reading ? <p role="status" className="muted">Checking AirPrompter…</p> : null}
    {comparison && run ? <>
      <p className="storage-note">Saved at {recordTime(run.at)} · published release #{comparison.generation} checked {ago(comparison.checkedAt)}.</p>
      <section className="record-list" aria-label="Release comparison"><div className="record-list-head"><h2>Saved vs published</h2><span className="fine muted">{run.host}</span></div>
        {[...comparison.steps].sort((a, b) => a.step === "reply" ? -1 : b.step === "reply" ? 1 : 0).map((s) => <button type="button" className="record-row" key={s.step} onClick={() => setStep(s.step)}><span><strong>{s.step} · {s.current ? s.matches && Object.values(s.matches).every((v) => v === true) ? "Matches published release" : "Differences to inspect" : "Unavailable in published release"}</strong><small>Saved {s.saved.versionId ?? "—"} · {armLabel(s.saved.arm ?? "none")} → published {s.current?.versionId ?? "—"} · {armLabel(s.current?.arm ?? "none")}</small></span><span className="record-open">Compare →</span></button>)}
      </section>
    </> : null}
    {inspected ? <SlideOut wide title={`${inspected.step}: saved vs AirPrompter`} onClose={() => setStep(null)}>
      <div className="scroll-x"><table className="evidence-table"><thead><tr><th>Field</th><th>Saved in Zudocs</th><th>Published in AirPrompter</th><th>Comparison</th></tr></thead><tbody>
        {([['generation','Release'],['version','Version'],['arm','A/B group'],['model','Model'],['settings','Settings'],['prompt','Rendered prompt']] as const).map(([key, label]) => {
          const value = (side: 'saved' | 'current') => { const facts = inspected[side]; if (!facts) return 'Unavailable'; switch (key) { case 'generation': return `#${facts.generation ?? '—'}`; case 'version': return facts.versionId ?? '—'; case 'arm': return armLabel(facts.arm ?? 'none'); case 'model': return modelLabel(facts.model); case 'settings': return settings(facts.inference); case 'prompt': return side === 'saved' ? savedStep?.rendered ? 'Saved with run' : 'Not saved' : inspected.text === null ? 'Cannot render' : 'Using saved values'; } };
          return <tr key={key}><th>{label}</th><td>{value('saved')}</td><td>{value('current')}</td><td>{inspected.matches?.[key] === true ? 'Same' : inspected.matches?.[key] === false ? 'Changed' : 'Unknown'}</td></tr>;
        })}
      </tbody></table></div>
      {inspected.reason ? <p className="muted fine">Comparison incomplete: {inspected.reason.replaceAll('_',' ')}. No replacement values were invented.</p> : null}
      <Fold title="Prompt text side by side"><div className="reply-comparison-grid"><section><h3>Saved in Zudocs</h3><ReplyText text={savedStep?.rendered?.text ?? 'No saved prompt.'} /></section><section><h3>Published in AirPrompter</h3><ReplyText text={inspected.text ?? 'Current prompt could not be rendered with saved values.'} /></section></div></Fold>
      <Fold title="Record and release identifiers"><dl className="integration-settings"><div><dt>Saved record</dt><dd>{run?.runId}</dd></div><div><dt>Published digest</dt><dd>{comparison?.releaseDigest}</dd></div><div><dt>Checked at</dt><dd>{comparison?.checkedAt}</dd></div></dl></Fold>
    </SlideOut> : null}
  </div>;
}
