/**
 * A read-only browser of the saved records exposed by the authenticated desk API.
 * Content is opened explicitly; record summaries exclude prompt bodies and run references.
 * @example
 * <Database tickets={tickets} runs={runs} selectedId={id} onSelect={select} state={state} approvals={approvals} events={events} reads={reads} runsReady={true} runsUnavailable={false} onRefresh={refresh} />
 */
import { useState } from "react";
import { isHostedRun, type AnyRun, type Approval, type HostStatus, type State, type Ticket, type TimelineEvent } from "../api";
import { ago, clock, modelLabel } from "../format";
import { settingLabel } from "./IntegrationStatus";
import { Fold } from "./Fold";
import { ReplyText } from "./ReplyText";
import { SlideOut } from "./SlideOut";
import { describeEvent } from "./Timeline";
import { WhyThisText } from "./WhyThisText";

export type RecordRead = { at: string | null; error: boolean };
export type RecordReads = Record<"tickets" | "hosts" | "approvals" | "events", RecordRead>;
type Collection = "replies" | "tickets" | "customers" | "hosts" | "approvals" | "events" | "usage";
const COLLECTIONS: [Collection, string, string][] = [
  ["replies", "Saved replies", "Up to 10 latest runs for the selected ticket, with their saved feedback."],
  ["tickets", "Tickets", "Ticket records, joined with their customers by the desk API."],
  ["customers", "Customers", "Customer records associated with the tickets in this inbox."],
  ["hosts", "Host reports", "Persisted reports from the status table. These can lag the live SDK check."],
  ["approvals", "Approvals", "Up to 50 latest saved approval records. Rollout plans are added by the API."],
  ["events", "Activity", "Recent saved events: initially up to 100 for the current UTC day, then new events as they arrive."],
  ["usage", "Daily usage", "The current UTC day's run counter and configured daily limit."],
];
export function runFields(run: AnyRun) {
  if (isHostedRun(run)) return { runId: run.runId, ticketId: run.ticketId, customerId: run.customerId, at: run.at, by: run.by, host: run.host, kind: run.kind, ok: run.ok, durationMs: run.durationMs,
    result: run.stream.result ? { versionId: run.stream.result.versionId, generation: run.stream.result.generation, arm: run.stream.result.arm, model: run.stream.result.model, usage: run.stream.result.usage, latencyMs: run.stream.result.latencyMs } : null, feedback: run.feedback?.accepted ?? null };
  return { runId: run.runId, ticketId: run.ticketId, customerId: run.customerId, at: run.at, by: run.by, host: run.host, kind: run.kind, route: run.route ?? "bedrock", generation: run.generation, applyState: run.applyState, durationMs: run.durationMs, ok: run.ok, capUsed: run.capUsed, triage: run.triage, feedback: run.feedback,
    steps: run.steps.map((step) => ({ step: step.step, tag: step.tag, versionId: step.versionId, generation: step.generation, arm: step.arm, model: step.model, inference: step.rendered?.inference ?? null, observation: step.observation, costUsd: step.costUsd, provider: step.provider ?? null, checks: step.checks, judge: step.judge, error: step.error })) };
}
function hostFields(host: HostStatus) {
  const status = host.status ?? {};
  const fields = ["generation", "stagedGeneration", "applyState", "source", "storageProtection", "applyPolicy", "lastSyncAt", "lastSyncOutcome", "consecutiveSyncFailures", "ramps", "leaseExpiresAt", "leaseExpired", "spool"];
  return { hostId: host.hostId, region: host.region, kind: host.kind, sdk: host.sdk, writtenAt: host.writtenAt, status: Object.fromEntries(fields.filter((key) => key in status).map((key) => [key, status[key]])), healthz: host.healthz, container: host.container };
}
function Fields({ value }: { value: unknown }) { return <pre className="record-fields">{JSON.stringify(value, null, 2)}</pre>; }
function SavedRun({ run }: { run: AnyRun }) {
  return <>
    <dl className="integration-settings">
      <div><dt>Ticket</dt><dd>{run.ticketId}</dd></div>
      <div><dt>Host</dt><dd>{run.host}</dd></div>
      <div><dt>Saved at</dt><dd>{run.at}</dd></div>
      <div><dt>Record ID</dt><dd>{run.runId}</dd></div>
    </dl>
    {isHostedRun(run) ? <Fold title="Saved reply content"><ReplyText text={run.stream.result?.output ?? run.stream.deltas.map((d) => d.text).join("")} /></Fold>
      : [...run.steps].sort((a, b) => a.step === "reply" ? -1 : b.step === "reply" ? 1 : 0).map((step) => <section key={step.step} className="saved-step">
        <h3>{step.step} · {step.versionId ?? "version unreported"}</h3>
        <p className="fine muted">{modelLabel(step.model)} · release #{step.generation} · {step.arm && step.arm !== "none" ? `${step.arm} group` : "published version"}</p>
        {step.rendered?.inference ? <dl className="integration-settings">{Object.entries(step.rendered.inference).map(([key, value]) => { const setting = settingLabel(key, value); return <div key={key}><dt>{setting.label}</dt><dd>{setting.value}</dd></div>; })}</dl> : null}
        <Fold title={`Saved ${step.step} content`}><ReplyText text={step.output ?? "No output saved."} /></Fold>
        {step.rendered ? <Fold title={`Saved ${step.step} prompt and variables`}><WhyThisText rendered={step.rendered} /></Fold> : null}
      </section>)}
    <Fold title="Record fields"><p className="fine muted">Saved run and feedback metadata. Content has separate disclosures; run references are omitted.</p><Fields value={runFields(run)} /></Fold>
  </>;
}

export function Database({ tickets, runs, selectedId, onSelect, state, approvals, events, reads, runsReady, runsReadAt, runsUnavailable, onRefresh }: {
  tickets: Ticket[]; runs: AnyRun[]; selectedId: string | null; onSelect: (id: string) => void; state: State | null; approvals: Approval[]; events: TimelineEvent[]; reads: RecordReads; runsReady: boolean; runsReadAt: string | null; runsUnavailable: boolean; onRefresh: () => void;
}) {
  const [collection, setCollection] = useState<Collection>("replies");
  const [picked, setPicked] = useState<{ title: string; content: React.ReactNode } | null>(null);
  const chosen = COLLECTIONS.find(([key]) => key === collection)!;
  const read = collection === "replies" ? { at: runsReadAt, error: runsUnavailable } : reads[collection === "hosts" || collection === "usage" ? "hosts" : collection === "approvals" ? "approvals" : collection === "events" ? "events" : "tickets"];
  const ready = collection === "replies" ? runsReady : read.at !== null;
  const error = collection === "replies" ? runsUnavailable || reads.tickets.error : read.error;
  const rows: { id: string; title: string; detail: string; content: React.ReactNode }[] =
    collection === "replies" ? [...runs].sort((a, b) => b.at.localeCompare(a.at)).map((run) => {
      const reply = !isHostedRun(run) ? run.steps.find((step) => step.step === "reply") ?? run.steps[0] : null;
      return { id: run.runId, title: `${reply?.versionId ?? (isHostedRun(run) ? run.stream.result?.versionId : null) ?? run.kind} · release #${isHostedRun(run) ? run.catalogue.generation : run.generation}`, detail: `${clock(run.at)} · ${run.host} · ${run.ok ? "answered" : "incomplete"}`, content: <SavedRun run={run} /> };
    }) : collection === "tickets" ? tickets.map((ticket) => ({ id: ticket.ticketId, title: ticket.subject, detail: `${ticket.ticketId} · ${ticket.customer?.name ?? ticket.customerId}`, content: <><Fields value={{ ticketId: ticket.ticketId, customerId: ticket.customerId, receivedAt: ticket.receivedAt, channel: ticket.channel, subject: ticket.subject, lastRun: ticket.lastRun }} /><Fold title="Saved customer message"><ReplyText text={ticket.body} /></Fold></> }))
    : collection === "customers" ? [...new Map(tickets.flatMap((ticket) => ticket.customer ? [[ticket.customer.customerId, ticket.customer] as const] : [])).values()].map((customer) => ({ id: customer.customerId, title: customer.name, detail: `${customer.tier} · ${customer.seats} seats`, content: <Fields value={customer} /> }))
    : collection === "hosts" ? (state?.hosts ?? []).map((host) => ({ id: host.hostId, title: `${host.region} · ${host.kind}`, detail: `Release #${host.status?.generation ?? "—"} · saved ${ago(host.writtenAt)}`, content: <><p className="fine muted">Persisted report written at {host.writtenAt}. Selected status fields shown below.</p><Fields value={hostFields(host)} /></> }))
    : collection === "approvals" ? approvals.map((row) => ({ id: row.approvalId, title: `Release #${row.generation} · ${row.decision}`, detail: `${row.hostId} · ${clock(row.stagedAt)}`, content: <Fields value={{ approvalId: row.approvalId, hostId: row.hostId, generation: row.generation, releaseDigest: row.releaseDigest, stagedAt: row.stagedAt, decision: row.decision, decidedBy: row.decidedBy, decidedAt: row.decidedAt, activatedAt: row.activatedAt, outcome: row.outcome, updatedAt: row.updatedAt }} /> }))
    : collection === "events" ? [...events].reverse().map((event, index) => ({ id: event.id ?? `${event.at}-${index}`, title: describeEvent(event), detail: `${clock(event.at)} · ${event.host}`, content: <Fields value={eventFields(event)} /> }))
    : state ? [{ id: state.cap.day, title: `${state.cap.used.toLocaleString()} runs today`, detail: `${state.cap.day} UTC · limit ${state.cap.cap.toLocaleString()}`, content: <Fields value={state.cap} /> }] : [];
  return <div className="page-content database">
    <header className="page-heading"><div><p className="eyebrow">Zudocs records</p><h1>Database</h1><p className="muted">Inspect the records behind the ticket and integration.</p></div><button type="button" className="chip-button" onClick={onRefresh}>Refresh records</button></header>
    <div className="database-tools"><label>Collection<select value={collection} onChange={(event) => { setCollection(event.target.value as Collection); setPicked(null); }}>{COLLECTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {collection === "replies" ? <label>Ticket<select value={selectedId ?? ""} onChange={(event) => { setPicked(null); onSelect(event.target.value); }}>{tickets.map((ticket) => <option key={ticket.ticketId} value={ticket.ticketId}>{ticket.ticketId} · {ticket.customer?.name ?? ticket.customerId}</option>)}</select></label> : null}</div>
    <p className="fine muted">{chosen[2]} {read.at ? `Last successful read ${ago(read.at)}.` : ""}</p>
    <p className="storage-note">Signed prompts are cached by the SDK on each host. This database records the prompt, version, settings and result used for each saved run.</p>
    {error ? <p className="problem" role="status">The latest read failed. {ready ? "Previously loaded records are shown." : "Refresh records to try again."}</p> : null}
    {!ready ? <p className="muted">{error ? "Records unavailable." : "Reading saved records…"}</p> : <section aria-label={chosen[1]} className="record-list">
      <div className="record-list-head"><h2>{chosen[1]}</h2><span className="fine muted">{rows.length} loaded</span></div>
      {rows.length ? rows.map((row) => <button type="button" className="record-row" key={row.id} onClick={() => setPicked({ title: row.title, content: row.content })}><span><strong>{row.title}</strong><small>{row.detail}</small></span><span className="record-open">Inspect →</span></button>) : <p className="empty muted">No records in this view.</p>}
    </section>}
    {picked ? <SlideOut title={picked.title} onClose={() => setPicked(null)}>{picked.content}</SlideOut> : null}
  </div>;
}

/** Known event metadata only; arbitrary payloads and CLI output are not part of the inspector. */
export function eventFields(event: TimelineEvent) {
  const names = ["id", "at", "kind", "host", "ticketId", "runId", "generation", "stagedGeneration", "applyState", "versionId", "model", "arm", "sdk", "decision", "outcome", "status", "by", "forHost", "policy", "source", "storageProtection"];
  return Object.fromEntries(names.filter((key) => key in event).map((key) => [key, event[key]]));
}
