/**
 * The presenter panel: what the owner presses during a session so nothing waits for a timer — replay N runs on
 * this host, a heartbeat / upload / sync now, a re-seed of the inbox — and the day's cap, read from the counter.
 * Every button is an API call; the result lands as a notice and on the timeline.
 *
 * @example
 * ```tsx
 * <Presenter state={state} busy={busy} onAction={(action, body) => api.presenter(action, body)} environment="dev" agentId="agent_…" />
 * ```
 */
import type { State } from "../api";
import { TOOLTIPS } from "../format";

export function Presenter({ state, busy, onAction, environment, agentId }: { state: State | null; busy: string | null; onAction: (action: string, body?: Record<string, unknown>) => void; environment: string; agentId: string }) {
  const cap = state?.cap;
  const disabled = busy !== null;
  return (
    <section className="presenter">
      <div className="pane-title"><h2>Presenter</h2><span className="muted" title={TOOLTIPS.cap}>{cap ? `${cap.used.toLocaleString()} / ${cap.cap.toLocaleString()} runs today` : "—"}</span></div>
      <div className="button-row">
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 5 })}>Replay 5</button>
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 12 })}>Replay 12</button>
      </div>
      <div className="button-row">
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("heartbeat")}>Heartbeat now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("upload")}>Upload now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("sync")}>Sync now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Re-seed the inbox? Tickets keep their ids; run headlines are cleared.")) onAction("seed"); }}>Re-seed</button>
      </div>
      <p className="muted fine">AirPrompter {environment} · {agentId}{state ? ` · this container ${state.host.instanceId.slice(0, 12)} (${state.host.invocations} inv)` : ""}</p>
    </section>
  );
}
