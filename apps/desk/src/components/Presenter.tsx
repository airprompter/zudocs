/**
 * The presenter panel: what the owner presses during a session so nothing waits for a timer — replay N runs on
 * this host, a heartbeat / upload / sync now, a re-seed of the inbox, "run this ticket on eu-west now" (the other
 * host's queue), the wire: cut (the eu-west host loses AirPrompter and Bedrock, keeps the desk's tables; a rule
 * restores it in 15 minutes whatever happens) and restore — and the nudge: one message on the fleet's queue, so the
 * puller reads the origin now instead of on its schedule. Every button is an API call; the result lands as a
 * notice and on the timeline. The day's cap is read from the counter.
 *
 * @example
 * ```tsx
 * <Presenter state={state} busy={busy} selectedTicketId="T-1041" onAction={(action, body) => api.presenter(action, body)} environment="dev" agentId="agent_…" />
 * ```
 */
import type { State } from "../api";
import { TOOLTIPS } from "../format";

export function Presenter({ state, busy, selectedTicketId, onAction, environment, agentId }: { state: State | null; busy: string | null; selectedTicketId: string | null; onAction: (action: string, body?: Record<string, unknown>) => void; environment: string; agentId: string }) {
  const cap = state?.cap;
  const disabled = busy !== null;
  // "Run this ticket there now" is for hosts that run tickets: the daemon host. The puller pulls; the air-gapped host has no model.
  const others = (state?.hosts ?? []).filter((h) => h.kind === "daemon").map((h) => h.hostId);
  const wire = state?.features?.wire ?? false;
  const nudge = state?.features?.nudge ?? false;
  return (
    <section className="presenter">
      <div className="pane-title"><h2>Presenter</h2><span className="muted" title={TOOLTIPS.cap}>{cap ? `${cap.used.toLocaleString()} / ${cap.cap.toLocaleString()} runs today` : "—"}</span></div>
      <div className="button-row">
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 5 })}>Replay 5</button>
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 12 })}>Replay 12</button>
        {others.map((hostId) => (
          <button key={hostId} type="button" className="button secondary" disabled={disabled || !selectedTicketId} onClick={() => selectedTicketId && onAction("enqueue", { ticketId: selectedTicketId, host: hostId })}>Run {selectedTicketId ?? "…"} on {hostId.split("/")[0]}</button>
        ))}
      </div>
      <div className="button-row">
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("heartbeat")}>Heartbeat now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("upload")}>Upload now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("sync")}>Sync now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Re-seed the inbox? Tickets keep their ids; run headlines are cleared.")) onAction("seed"); }}>Re-seed</button>
      </div>
      {nudge ? (
        <div className="button-row" title={TOOLTIPS.nudge}>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("nudge")}>Nudge the fleet</button>
          <span className="muted fine">placeholder for change notification: the puller reads the origin now</span>
        </div>
      ) : null}
      {wire ? (
        <div className="button-row" title={TOOLTIPS.wire}>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Cut the eu-west host's wire? AirPrompter and Bedrock go dark for it; the desk's tables stay; a rule restores it in 15 minutes.")) onAction("cut_wire"); }}>Cut the wire (eu-west)</button>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("restore_wire")}>Restore the wire</button>
        </div>
      ) : null}
      <p className="muted fine">AirPrompter {environment} · {agentId}{state ? ` · this container ${state.host.instanceId.slice(0, 12)} (${state.host.invocations} inv)` : ""}</p>
    </section>
  );
}
