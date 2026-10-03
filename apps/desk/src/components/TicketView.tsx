/**
 * One ticket and what the desk did with it: the customer's message, the Run, Escalate and (when the deployment
 * names a run key) Run-on-staging buttons — the route picker beside Run (phase 9: the same reply through your own
 * cloud, the OpenAI API, the Claude API or AirPrompter's hosted route; a door the deployment has no key for is
 * shown and disabled, never hidden), **Compare all** (one click, every configured door in turn) and, once two
 * routes have answered, the compare table: latest run per route, its model, latency, tokens, cost, checks, judge,
 * feedback — nothing computed here, every cell is the record's — with a red band while the environment is frozen (Run stays clickable:
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
import { isHostedRun, type AnyRun, type DirectProvider, type HostedRun, type Route, type Run, type Step, type Ticket } from "../api";
import { ROUTES, TOOLTIPS, ago, armLabel, checkLine, clock, latency, modelLabel, money, replyByline, routeLabel, score, syncLead, testLine, versionBadge } from "../format";
import { Behind } from "./Behind";
import { Fold } from "./Fold";
import { IntegrationFlow } from "./IntegrationFlow";
import { WhyThisText } from "./WhyThisText";

export interface RouteAvailability {
  configured: boolean;
  model: string | null;
  /** Phase 9: the owner's kill switch for a direct door, and what it has spent of its own daily line. */
  door?: { open: boolean; reason: string | null };
  used?: number;
  cap?: number;
}

/** Why a route cannot be clicked, in the desk's own words; null when it can. Pure. */
export function routeRefusal(route: Route, availability: RouteAvailability): string | null {
  if (!availability.configured) return `${routeLabel(route)}: not configured on this deployment (RUNBOOK.md › Keys)`;
  if (availability.door && !availability.door.open) return `${routeLabel(route)}: the door is closed (${availability.door.reason}) — the owner opens it on the presenter panel`;
  if (availability.cap !== undefined && (availability.used ?? 0) >= availability.cap) return `${routeLabel(route)}: ${availability.used} of ${availability.cap} calls used today; it refuses past its own daily line`;
  return null;
}

export function TicketView({ ticket, runs, busy, frozen, routes, enqueue, elsewhere, desk, emptyNote, onBehind, onRun, onEscalate, onFeedback }: { ticket: Ticket; runs: AnyRun[]; busy: string | null; frozen: { frozen: boolean; reason: string | null } | null; hosted: { target: string; runUrl: string } | null; routes: Record<Route, RouteAvailability>; enqueue: { label: string; disabled: boolean; note: string | null; onEnqueue: () => void } | null; elsewhere: { href: string; label: string; onClick: (event: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }) => void } | null; desk: { generation: number | null; staged: number | null; updatedAt: string | null } | null; emptyNote: string; onBehind?: (id: string) => void; onRun: (provider?: DirectProvider) => void; onEscalate: () => void; onHosted: () => void; onCompareAll: () => void; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  const isFrozen = frozen?.frozen ?? false;
  const disabled = busy !== null;
  const blocked = routeRefusal("bedrock", routes.bedrock);
  const ordered = [...runs].sort((a, b) => (a.at < b.at ? 1 : -1));
  const latest = ordered[0] ?? null;
  const earlier = ordered.slice(1);
  return (
    <div className="ticket-view">
      <section className="ticket-card">
        <div className="ticket-head">
          <div>
            <h1>{ticket.subject}</h1>
            <p className="muted">{ticket.customer?.name ?? ticket.customerId} · <span className={`chip tier-${ticket.customer?.tier ?? "unknown"}`}>{ticket.customer?.tier ?? "—"}</span>{ticket.customer ? ` · ${ticket.customer.seats} seats` : ""} · {ticket.ticketId}</p>
          </div>
          <div className="actions" title={isFrozen ? `frozen: ${frozen?.reason ?? ""}` : undefined}>
            {enqueue ? (
              <button type="button" className="button" disabled={disabled || enqueue.disabled} title={enqueue.note ?? undefined} onClick={enqueue.onEnqueue}>{busy === "enqueue" ? "Enqueueing…" : enqueue.label}</button>
            ) : (
              <>
                <button type="button" className="button" disabled={disabled || blocked !== null} onClick={() => onRun()} title={blocked ?? undefined}>{busy === "run" || busy === "hosted" ? "Writing…" : "Draft reply"}</button>
                <button type="button" className="button secondary" disabled={disabled} onClick={onEscalate}>{busy === "escalate" ? "Escalating…" : "Escalate"}</button>
              </>
            )}
          </div>
        </div>
        {isFrozen ? <p className="problem fine">Frozen from the console — this host refuses to render: {frozen?.reason}. Draft reply answers HTTP 423; unfreeze in AirPrompter and the next sync lifts it.</p> : null}
        <p className="eyebrow thread-from">From the customer</p>
        <blockquote className="ticket-body">{ticket.body}</blockquote>
      </section>
      {latest ? (isHostedRun(latest) ? <HostedPanel run={latest} /> : <RunPanel run={latest} busy={busy} elsewhere={elsewhere} desk={desk} enqueueNote={enqueue?.note ?? null} onBehind={onBehind} onFeedback={onFeedback} />) : <p className="muted centre-note">{emptyNote}</p>}
      {earlier.length ? (
        <Fold title={`Earlier replies · ${earlier.length}`}>
          {earlier.map((run) => (isHostedRun(run) ? <HostedPanel key={run.runId} run={run} /> : <RunPanel key={run.runId} run={run} busy={busy} elsewhere={null} desk={desk} enqueueNote={null} onBehind={onBehind} onFeedback={onFeedback} />))}
        </Fold>
      ) : null}
      <CompareTable runs={runs} />
    </div>
  );
}

/** One row per route: the facts of the latest run that went that way. Pure over the records. */
export function compareRows(runs: AnyRun[]): Array<{ route: Route; at: string; model: string | null; latencyMs: number | null; tokens: { input?: number; output?: number } | undefined; costUsd: number | null; checks: { passed: number; failed: number } | null; judge: Step["judge"]; feedback: string[]; ok: boolean; error: string | null }> {
  const rows = new Map<Route, ReturnType<typeof compareRows>[number]>();
  for (const run of [...runs].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    if (isHostedRun(run)) {
      if (rows.has("airprompter")) continue;
      const r = run.stream.result;
      rows.set("airprompter", { route: "airprompter", at: run.at, model: r?.model ?? null, latencyMs: r?.latencyMs ?? null, tokens: r ? { input: r.usage.inputTokens, output: r.usage.outputTokens } : undefined, costUsd: r ? r.priceMicros / 1_000_000 : null, checks: null, judge: null, feedback: run.feedback?.accepted ? ["thumbs up"] : [], ok: run.ok, error: run.stream.refusal ? `${run.stream.refusal.code} (HTTP ${run.stream.refusal.status})` : null });
      continue;
    }
    if (run.kind !== "run") continue;
    const route: Route = run.route ?? "bedrock";
    if (rows.has(route)) continue;
    const reply = run.steps.find((s) => s.step === "reply");
    const o = reply?.observation ?? null;
    const filed = (run.feedback ?? []).filter((f) => f.filed).flatMap((f) => Object.entries(f.signals).map(([k, v]) => (k === "thumbs" ? `thumbs ${String(v)}` : k)));
    rows.set(route, { route, at: run.at, model: reply?.model ?? null, latencyMs: o?.latencyMs ?? null, tokens: o?.tokens, costUsd: reply?.costUsd ?? null, checks: reply ? { passed: reply.checks.filter((c) => c.verdict === "pass").length, failed: reply.checks.filter((c) => c.verdict === "fail").length } : null, judge: reply?.judge ?? null, feedback: [...new Set(filed)], ok: run.ok, error: reply?.error ? `${reply.error.name}: ${reply.error.message}` : null });
  }
  return ROUTES.filter((r) => rows.has(r)).map((r) => rows.get(r)!);
}

/** The compare table: shown once two routes have answered this ticket; every cell is a record's own number. */
function CompareTable({ runs }: { runs: AnyRun[] }) {
  const rows = compareRows(runs);
  if (rows.length < 2) return null;
  return (
    <Fold title={`Same ticket, ${rows.length} routes`}>
    <section className="compare" title={TOOLTIPS.routes}>
      <div className="run-head"><span className="muted">The same ticket, the same prompt — {rows.length} routes, latest run each.</span></div>
      <div className="table-wrap">
        <table className="compare-table">
          <thead><tr><th>route</th><th>model</th><th>latency</th><th>tokens</th><th>cost</th><th>checks</th><th>judge</th><th>feedback</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.route} className={row.ok ? "" : "row-failed"}>
                <td><span className={`badge route${row.route === "bedrock" ? " route-home" : ""}`}>{routeLabel(row.route)}</span></td>
                <td>{modelLabel(row.model)}</td>
                <td>{latency(row.latencyMs)}</td>
                <td>{row.tokens ? `${(row.tokens.input ?? 0).toLocaleString()} in · ${(row.tokens.output ?? 0).toLocaleString()} out` : "—"}</td>
                <td>{money(row.costUsd)}</td>
                <td>{row.error ? <span className="refusal">{row.error}</span> : row.checks ? `${row.checks.passed} ✓${row.checks.failed ? ` · ${row.checks.failed} ✗` : ""}` : <span className="muted">not on the hosted record</span>}</td>
                <td>{row.judge ? score(row.judge) : <span className="muted">—</span>}</td>
                <td>{row.feedback.length ? row.feedback.join(", ") : <span className="muted">none yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted fine">cost is list price from reported usage; the hosted route's price is the route's own price book; the judge runs on this host's judge model for the runs it made.</p>
    </section>
    </Fold>
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
  const letter = deltas.slice(0, shown || (replaying ? 0 : deltas.length)).map((d) => d.text).join("");
  return (
    <section className={`run hosted letter${run.ok ? "" : " run-failed"}`}>
      {run.stream.refusal ? <p className="problem">the run route refused: {run.stream.refusal.code} (HTTP {run.stream.refusal.status}) — {run.stream.refusal.message}{run.stream.refusal.detail ? ` · ${run.stream.refusal.detail}` : ""}</p> : <pre className="output reply">{letter}{replaying && shown < deltas.length ? "▍" : ""}</pre>}
      {result && !run.stream.refusal ? <p className="byline" title={TOOLTIPS.version}>{replyByline(run.catalogue.slot?.tag ?? "support.reply", result.versionId, result.generation, result.arm)}</p> : null}
      <Fold title="Details">
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
        <p className="muted fine">{deltas.length} deltas over {latency(total)} as the route sent them (first byte {latency(run.stream.firstByteMs)} after the POST); the replay keeps every gap as recorded — a recording, not an animation.</p>
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
                <div><dt>temperature</dt><dd>{run.compat.request.temperature} <span className="refusal" title={TOOLTIPS.ignoredByContract}>{run.compat.ignoredByContract.includes("temperature") ? "ignored by contract" : "sent"}</span></dd></div>
                <div><dt>top_p</dt><dd>{run.compat.request.top_p} <span className="refusal" title={TOOLTIPS.ignoredByContract}>{run.compat.ignoredByContract.includes("top_p") ? "ignored by contract" : "sent"}</span></dd></div>
                <div><dt>variables</dt><dd>{run.compat.request.variables.join(", ") || "—"} <span className="muted">via airprompter.variables</span></dd></div>
              </dl>
              <p className="muted fine">ignored by contract: the release owns these settings, and the response carries no settings — the chip is the contract's word, not something the route reported.</p>
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
      </Fold>
    </section>
  );
}

function RunPanel({ run, busy, elsewhere, desk, enqueueNote, onBehind, onFeedback }: { run: Run; busy: string | null; elsewhere: { href: string; label: string; onClick: (event: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }) => void } | null; desk: { generation: number | null; staged: number | null; updatedAt: string | null } | null; enqueueNote: string | null; onBehind?: (id: string) => void; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  const step = (name: Step["step"]) => run.steps.find((s) => s.step === name) ?? null;
  const reply = step("reply");
  const summary = step("summary");
  const handoff = step("handoff");
  const letter = reply ?? summary ?? handoff;
  const checks = checkLine(letter?.checks ?? []);
  return (
    <section className={`run letter${run.ok ? "" : " run-failed"}`}>
      {reply ? (reply.error ? <p className="problem">{reply.error.name}: {reply.error.message}</p> : <pre className="output reply">{reply.output ?? ""}</pre>) : null}
      {!reply && summary ? (summary.error ? <p className="problem">{summary.error.name}: {summary.error.message}</p> : <pre className="output reply">{summary.output ?? ""}</pre>) : null}
      {handoff ? (handoff.error ? <p className="problem">{handoff.error.name}: {handoff.error.message}</p> : <pre className="output">{handoff.output ?? ""}</pre>) : null}
      {letter && !letter.error ? <p className="byline" title={TOOLTIPS.version}>{replyByline(letter.tag, letter.versionId, letter.generation, letter.arm)}</p> : null}
      <Fold title="How this reply got here">
        <div className="sync">
          <IntegrationFlow label="How AirPrompter and Zudocs produced this reply" steps={[
            { title: "AirPrompter release", detail: `Release #${letter?.generation ?? "—"} supplied the versioned prompt and checks.` },
            { title: "Zudocs host", detail: `${run.host} ran ${letter?.tag ?? "the prompt"}${letter?.versionId ? ` ${letter.versionId}` : ""}${letter?.arm && letter.arm !== "none" ? ` for the ${armLabel(letter.arm)} group` : ""}.` },
            { title: "Reply and evidence", detail: `${checks || "No checks on this step."}${letter?.observation?.latencyMs != null ? ` Answered in ${latency(letter.observation.latencyMs)}.` : ""}` },
          ]} />
          <p>{syncLead(letter?.generation ?? null, desk?.generation ?? null)}{desk?.updatedAt ? ` AirPrompter last updated this desk ${ago(desk.updatedAt)}.` : ""}</p>
          {desk?.staged != null ? <p>Release #{desk.staged} is waiting. Replies keep using the release already running until it is approved.</p> : null}
          {letter ? <p title={TOOLTIPS.arm}>{testLine(letter.arm)}</p> : null}
          {run.triage?.category || run.triage?.priority ? <p>The agent read this as {run.triage.category ?? "—"}, {run.triage.priority ?? "—"}.{run.triage.summary ? ` ${run.triage.summary}` : ""}</p> : null}
          {checks ? <p>{checks}</p> : null}
          {letter?.judge ? <p title={TOOLTIPS.judge}>Quality {score(letter.judge)}.</p> : null}
          {letter?.model ? <p className="muted">Answered with {modelLabel(letter.model)}.</p> : null}
          {letter?.rendered ? <Fold title="The prompt AirPrompter filled in"><WhyThisText rendered={letter.rendered} /></Fold> : null}
          {reply ? <FeedbackRow run={run} step="reply" busy={busy} onFeedback={onFeedback} /> : null}
          {handoff ? <FeedbackRow run={run} step="handoff" busy={busy} onFeedback={onFeedback} /> : null}
          {enqueueNote ? <p className="muted">{enqueueNote}</p> : null}
          {elsewhere ? <p><a href={elsewhere.href} onClick={elsewhere.onClick}>{elsewhere.label}</a></p> : null}
          {onBehind ? <p className="behind-row"><Behind id="run-step" onOpen={onBehind} title={TOOLTIPS.version}>how this reply is written</Behind></p> : null}
        </div>
      </Fold>
    </section>
  );
}

function FeedbackRow({ run, step, busy, onFeedback }: { run: Run; step: string; busy: string | null; onFeedback: (runId: string, step: string, signals: Record<string, unknown>) => void }) {
  const filed = (run.feedback ?? []).filter((f) => f.filed).map((f) => f.signals);
  const has = (key: string, value?: unknown) => filed.some((signals) => key in signals && (value === undefined || signals[key] === value));
  const filedNames = [...new Set(filed.flatMap((signals) => Object.entries(signals).map(([k, v]) => (k === "thumbs" ? `thumbs ${String(v)}` : k))))];
  const disabled = busy !== null || !run.steps.find((s) => s.step === step)?.runRef;
  return (
    <div className="feedback">
      <span className="muted">Rate this reply</span>
      <button type="button" className={`chip-button${has("thumbs", "up") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { thumbs: "up" })}>👍 Good</button>
      <button type="button" className={`chip-button${has("thumbs", "down") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { thumbs: "down" })}>👎 Poor</button>
      <button type="button" className={`chip-button${has("accepted") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { accepted: true })}>Sent as is</button>
      <button type="button" className={`chip-button${has("edited") ? " done" : ""}`} disabled={disabled} onClick={() => onFeedback(run.runId, step, { edited: true })}>Edited first</button>
      {filedNames.length ? <span className="muted">filed: {filedNames.join(", ")}</span> : null}
    </div>
  );
}
