/**
 * One ticket and what the desk did with it: the customer's message, the Run, Escalate and (when the deployment
 * names a run key) Run-on-staging buttons — with a red band while the environment is frozen (Run stays clickable:
 * the click answers the SDK's refusal, `HTTP 423 frozen`, and that is the beat) — then every run newest first: a triage card, the reply card (version badge, arm badge, "Why this text", the
 * checks strip, latency / tokens / usage source / cost, the judge score, the feedback row), for an escalation the
 * summary and the hand-off note, and for a hosted staging run the stream replayed at the cadence it really had, the
 * `done` frame's facts, the feedback answer, and the compatible-endpoint request beside the catalogue's sealed
 * settings. A step the model refused shows the SDK's error class and the message, in place of an answer; a hosted
 * step the route refused shows the route's code and status, in place of an answer.
 *
 * @example
 * ```tsx
 * <TicketView ticket={ticket} runs={runs} busy={null} frozen={null} hosted={null} onRun={run} onEscalate={escalate} onHosted={hosted} onFeedback={feedback} />
 * ```
 */
import { useEffect, useState } from "react";
import { isHostedRun, type AnyRun, type HostedRun, type Run, type Step, type Ticket } from "../api";
import { TOOLTIPS, armLabel, clock, latency, modelLabel, money, score, slug, tokens, versionBadge } from "../format";
import { WhyThisText } from "./WhyThisText";

export function TicketView({ ticket, runs, busy, frozen, hosted, onRun, onEscalate, onHosted, onFeedback }: { ticket: Ticket; runs: AnyRun[]; busy: string | null; frozen: { frozen: boolean; reason: string | null } | null; hosted: { target: string; runUrl: string } | null; onRun: () => void; onEscalate: () => void; onHosted: () => void; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  const isFrozen = frozen?.frozen ?? false;
  const disabled = busy !== null;
  return (
    <div className="ticket-view">
      <section className="ticket-card">
        <div className="ticket-head">
          <div>
            <p className="eyebrow">{ticket.ticketId} · {ticket.channel} · {clock(ticket.receivedAt)}</p>
            <h1>{ticket.subject}</h1>
            <p className="muted">{ticket.customer?.name ?? ticket.customerId} · <span className={`chip tier-${ticket.customer?.tier ?? "unknown"}`}>{ticket.customer?.tier ?? "—"}</span> {ticket.customer ? `· ${ticket.customer.seats} seats · since ${ticket.customer.since}` : ""}</p>
          </div>
          <div className="actions" title={isFrozen ? `frozen: ${frozen?.reason ?? ""}` : undefined}>
            <button type="button" className="button" disabled={disabled} onClick={onRun}>{busy === "run" ? "Running…" : "Run"}</button>
            <button type="button" className="button secondary" disabled={disabled} onClick={onEscalate}>{busy === "escalate" ? "Escalating…" : "Escalate"}</button>
            {hosted ? <button type="button" className="button secondary" disabled={disabled} onClick={onHosted} title={TOOLTIPS.hosted}>{busy === "hosted" ? "Running on staging…" : `Run on ${hosted.target} (hosted)`}</button> : null}
          </div>
        </div>
        {isFrozen ? <p className="problem fine">Frozen from the console — this host refuses to render: {frozen?.reason}. Run answers HTTP 423; unfreeze in AirPrompter and the next sync lifts it.</p> : null}
        <blockquote className="ticket-body">{ticket.body}</blockquote>
      </section>
      {runs.length === 0 ? <p className="muted centre-note">No runs yet. Run sends this ticket through the promoted prompts on this host.</p> : null}
      {runs.map((run) => (isHostedRun(run) ? <HostedPanel key={run.runId} run={run} /> : <RunPanel key={run.runId} run={run} busy={busy} onFeedback={onFeedback} />))}
    </div>
  );
}

/**
 * The stream, replayed: the deltas the route sent, each shown at the offset it arrived at — a recording, and the
 * panel says so — then the `done` frame's facts and the compatible-endpoint call beside the sealed settings.
 */
function HostedPanel({ run }: { run: HostedRun }) {
  const deltas = run.stream.deltas;
  const [shown, setShown] = useState(0);
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    if (!replaying) return;
    if (shown >= deltas.length) { setReplaying(false); return; }
    const wait = shown === 0 ? 0 : Math.max(0, deltas[shown]!.atMs - deltas[shown - 1]!.atMs);
    const timer = setTimeout(() => setShown((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [replaying, shown, deltas]);
  const result = run.stream.result;
  const inference = run.catalogue.slot?.inference ?? null;
  const total = deltas.length ? deltas[deltas.length - 1]!.atMs : 0;
  return (
    <section className={`run hosted${run.ok ? "" : " run-failed"}`}>
      <div className="run-head">
        <span className="muted">Hosted run on {run.target} · {clock(run.at)} · via {run.runUrl.replace("https://", "")} · by {run.by} · {latency(run.durationMs)} end to end · release #{run.catalogue.generation}</span>
      </div>
      {run.gaps.length ? <p className="problem fine">{run.gaps.map((g, i) => <span key={i}>{g}<br /></span>)}</p> : null}
      <article className="step">
        <header className="step-head">
          <h3>Stream</h3>
          {result ? <>
            <span className="badge version" title={TOOLTIPS.version}>{versionBadge(run.catalogue.slot?.tag ?? "support.reply", result.versionId, result.generation)}</span>
            <span className="badge model">{modelLabel(result.model)}</span>
            <span className={`badge arm${result.arm !== "none" ? " arm-live" : ""}`} title={TOOLTIPS.arm}>{armLabel(result.arm)}</span>
          </> : <span className="badge model">no run</span>}
          {deltas.length ? <button type="button" className="link" onClick={() => { setShown(0); setReplaying(true); }}>{replaying ? "Replaying…" : shown ? "Replay the stream again" : "Replay the stream"}</button> : null}
        </header>
        {run.stream.refusal ? <p className="problem">the run route refused: {run.stream.refusal.code} (HTTP {run.stream.refusal.status}) — {run.stream.refusal.message}{run.stream.refusal.detail ? ` · ${run.stream.refusal.detail}` : ""}</p> : (
          <>
            <pre className="output reply">{deltas.slice(0, shown || (replaying ? 0 : deltas.length)).map((d) => d.text).join("")}{replaying && shown < deltas.length ? "▍" : ""}</pre>
            <p className="muted fine">{deltas.length} deltas over {latency(total)} as the route sent them (first byte {latency(run.stream.firstByteMs)} after the POST); the replay keeps every gap as recorded — a recording, not an animation.</p>
          </>
        )}
        {result ? (
          <dl className="metrics">
            <div><dt>latency</dt><dd>{latency(result.latencyMs)}</dd></div>
            <div><dt>tokens</dt><dd>{result.usage.inputTokens.toLocaleString()} in · {result.usage.outputTokens.toLocaleString()} out</dd></div>
            <div><dt>price</dt><dd>{money(result.priceMicros / 1_000_000)} <span className="muted">· book {result.priceBookRevision}</span></dd></div>
            <div><dt>stop</dt><dd>{result.stopReason}</dd></div>
            <div><dt>source</dt><dd>{result.source}</dd></div>
            <div><dt>feedback</dt><dd>{run.feedback ? (run.feedback.accepted ? `thumbs up accepted · ${String((run.feedback.attributedTo as { arm?: string } | null)?.arm ?? "")}` : `refused: ${run.feedback.refusal?.code ?? "?"}`) : "—"}</dd></div>
          </dl>
        ) : null}
        <p className="muted fine">subject hash {run.subjectHash ? `${run.subjectHash.slice(0, 16)}…` : "—"} (the customer id never leaves the desk)</p>
      </article>
      {run.compat ? (
        <article className="step">
          <header className="step-head"><h3>OpenAI-compatible endpoint</h3><span className="badge model">{run.compat.request.model}</span><span className={`badge ${run.compat.response.status === 200 ? "version" : "arm"}`}>HTTP {run.compat.response.status}</span></header>
          <div className="side-by-side">
            <div>
              <p className="eyebrow">The request (what the caller asked)</p>
              <dl className="kv">
                <div><dt>temperature</dt><dd>{run.compat.request.temperature} <span className="refusal">ignored</span></dd></div>
                <div><dt>top_p</dt><dd>{run.compat.request.top_p} <span className="refusal">ignored</span></dd></div>
                <div><dt>variables</dt><dd>{run.compat.request.variables.join(", ") || "—"} <span className="muted">via airprompter.variables</span></dd></div>
              </dl>
            </div>
            <div>
              <p className="eyebrow">The run's settings (sealed on the version)</p>
              {inference ? (
                <dl className="kv">
                  {Object.entries(inference).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
                </dl>
              ) : <p className="muted fine">no inference block on the catalogue</p>}
              <p className="muted fine">from the hosted catalogue (GET …/slots): the response carries no inference block; the release owns these — temperature, top-p and the output cap — never the caller.</p>
            </div>
          </div>
          {run.compat.response.error ? <p className="problem fine">the endpoint answered: {JSON.stringify(run.compat.response.error)}</p> : <pre className="output">{run.compat.response.text ?? ""}</pre>}
          <p className="muted fine">answer model {run.compat.response.model ?? "—"} · finish {run.compat.response.finishReason ?? "—"} · runRef {run.compat.response.runRef ? `${run.compat.response.runRef.slice(0, 12)}…` : "—"} · runId {run.compat.response.runId ?? "—"}</p>
        </article>
      ) : null}
    </section>
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
