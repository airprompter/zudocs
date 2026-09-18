/**
 * One ticket and what the desk did with it: the customer's message, the Run and Escalate buttons, then every run
 * newest first — a triage card, the reply card (version badge, arm badge, "Why this text", the checks strip,
 * latency / tokens / usage source / cost, the judge score, the feedback row), and for an escalation the summary
 * and the hand-off note. A step the model refused shows the SDK's error class and the message, in place of an
 * answer.
 *
 * @example
 * ```tsx
 * <TicketView ticket={ticket} runs={runs} busy={null} onRun={run} onEscalate={escalate} onFeedback={feedback} />
 * ```
 */
import { useState } from "react";
import type { Run, Step, Ticket } from "../api";
import { TOOLTIPS, armLabel, clock, latency, modelLabel, money, score, slug, tokens, versionBadge } from "../format";
import { WhyThisText } from "./WhyThisText";

export function TicketView({ ticket, runs, busy, onRun, onEscalate, onFeedback }: { ticket: Ticket; runs: Run[]; busy: string | null; onRun: () => void; onEscalate: () => void; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  return (
    <div className="ticket-view">
      <section className="ticket-card">
        <div className="ticket-head">
          <div>
            <p className="eyebrow">{ticket.ticketId} · {ticket.channel} · {clock(ticket.receivedAt)}</p>
            <h1>{ticket.subject}</h1>
            <p className="muted">{ticket.customer?.name ?? ticket.customerId} · <span className={`chip tier-${ticket.customer?.tier ?? "unknown"}`}>{ticket.customer?.tier ?? "—"}</span> {ticket.customer ? `· ${ticket.customer.seats} seats · since ${ticket.customer.since}` : ""}</p>
          </div>
          <div className="actions">
            <button type="button" className="button" disabled={busy !== null} onClick={onRun}>{busy === "run" ? "Running…" : "Run"}</button>
            <button type="button" className="button secondary" disabled={busy !== null} onClick={onEscalate}>{busy === "escalate" ? "Escalating…" : "Escalate"}</button>
          </div>
        </div>
        <blockquote className="ticket-body">{ticket.body}</blockquote>
      </section>
      {runs.length === 0 ? <p className="muted centre-note">No runs yet. Run sends this ticket through the promoted prompts on this host.</p> : null}
      {runs.map((run) => <RunPanel key={run.runId} run={run} busy={busy} onFeedback={onFeedback} />)}
    </div>
  );
}

function RunPanel({ run, busy, onFeedback }: { run: Run; busy: string | null; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  const step = (name: Step["step"]) => run.steps.find((s) => s.step === name) ?? null;
  const triage = step("triage");
  const reply = step("reply");
  const summary = step("summary");
  const handoff = step("handoff");
  return (
    <section className={`run${run.ok ? "" : " run-failed"}`}>
      <div className="run-head">
        <span className="muted">{run.kind === "run" ? "Run" : "Escalation"} · {clock(run.at)} · {run.host} · by {run.by} · {latency(run.durationMs)} end to end · run {run.capUsed.toLocaleString()} of the day</span>
      </div>
      {triage ? <StepCard step={triage} title="Triage" body={run.triage ? <TriageBody triage={run.triage} raw={triage.output} /> : <pre className="output">{triage.output ?? ""}</pre>} /> : null}
      {reply ? <StepCard step={reply} title="Reply" body={<pre className="output reply">{reply.output ?? ""}</pre>} feedback={<FeedbackRow run={run} step="reply" busy={busy} onFeedback={onFeedback} />} /> : null}
      {summary ? <StepCard step={summary} title="Summary" body={<pre className="output">{summary.output ?? ""}</pre>} /> : null}
      {handoff ? <StepCard step={handoff} title="Hand-off note" body={<pre className="output">{handoff.output ?? ""}</pre>} feedback={<FeedbackRow run={run} step="handoff" busy={busy} onFeedback={onFeedback} />} /> : null}
    </section>
  );
}

function TriageBody({ triage, raw }: { triage: NonNullable<Run["triage"]>; raw: string | null }) {
  if (!triage.category && !triage.priority) return <pre className="output">{raw ?? ""}</pre>;
  return (
    <div className="triage">
      <span className={`chip cat-${slug(triage.category)}`}>{triage.category ?? "—"}</span>
      <span className={`chip prio-${slug(triage.priority)}`}>{triage.priority ?? "—"}</span>
      <span className="triage-summary">{triage.summary}</span>
    </div>
  );
}

function StepCard({ step, title, body, feedback }: { step: Step; title: string; body: React.ReactNode; feedback?: React.ReactNode }) {
  const [why, setWhy] = useState(false);
  const o = step.observation;
  return (
    <article className="step">
      <header className="step-head">
        <h3>{title}</h3>
        <span className="badge version" title={TOOLTIPS.version}>{versionBadge(step.tag, step.versionId, step.generation)}</span>
        <span className="badge model">{modelLabel(step.model)}</span>
        <span className={`badge arm${step.arm && step.arm !== "none" ? " arm-live" : ""}`} title={TOOLTIPS.arm}>{armLabel(step.arm)}</span>
        {step.rendered ? <button type="button" className="link" onClick={() => setWhy((v) => !v)}>{why ? "Hide" : "Why this text"}</button> : null}
      </header>
      {why && step.rendered ? <WhyThisText rendered={step.rendered} /> : null}
      {step.error ? <p className="problem">{step.error.name}: {step.error.message}{o?.errorClass ? ` (observed as ${o.errorClass})` : ""}</p> : body}
      <div className="checks">
        {step.checks.length === 0 ? <span className="muted">no output checks declared</span> : step.checks.map((c) => <span key={c.name} className={`chip check-${c.verdict}`} title={c.reason ? `${c.kind}: ${c.reason}` : c.kind}>{c.verdict === "pass" ? "✓" : "✗"} {c.name}</span>)}
      </div>
      <dl className="metrics">
        <div><dt>latency</dt><dd>{latency(o?.latencyMs)}</dd></div>
        <div><dt>tokens</dt><dd>{tokens(o?.tokens, o?.usageSource)}</dd></div>
        <div><dt title={TOOLTIPS.usage}>usage</dt><dd>{o?.usageSource ?? "—"}</dd></div>
        <div><dt>cost</dt><dd>{money(step.costUsd)}</dd></div>
        <div><dt>status</dt><dd>{o?.status ?? "—"}</dd></div>
        {step.judge ? <div><dt title={TOOLTIPS.judge}>judge</dt><dd>{score(step.judge)} <span className="muted">on {modelLabel(step.judge.model)}{step.judge.flagged ? " · flagged" : ""}</span></dd></div> : null}
      </dl>
      {feedback}
    </article>
  );
}

function FeedbackRow({ run, step, busy, onFeedback }: { run: Run; step: string; busy: string | null; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  const filed = (run.feedback ?? []).filter((f) => f.filed).map((f) => f.signals);
  const has = (key: string, value?: unknown) => filed.some((signals) => key in signals && (value === undefined || signals[key] === value));
  const filedNames = [...new Set(filed.flatMap((signals) => Object.entries(signals).map(([k, v]) => (k === "thumbs" ? `thumbs ${String(v)}` : k))))];
  const disabled = busy !== null || !run.steps.find((s) => s.step === step)?.runRef;
  return (
    <div className="feedback">
      <span className="muted">Feedback</span>
      <button type="button" className={`chip-button${has("thumbs", "up") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { thumbs: "up" })}>👍 Good</button>
      <button type="button" className={`chip-button${has("thumbs", "down") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { thumbs: "down" })}>👎 Poor</button>
      <button type="button" className={`chip-button${has("accepted") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { accepted: true })}>Sent as is</button>
      <button type="button" className={`chip-button${has("edited") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { edited: true })}>Edited first</button>
      {filedNames.length ? <span className="muted">filed: {filedNames.join(", ")}</span> : null}
    </div>
  );
}
