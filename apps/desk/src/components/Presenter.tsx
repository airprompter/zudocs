/**
 * The presenter panel: what the owner presses during a session so nothing waits for a timer — replay N runs on
 * this host, a heartbeat / upload / sync now, a re-seed of the inbox, "run this ticket on eu-west now" (the other
 * host's queue), the wire: cut (the eu-west host loses AirPrompter and Bedrock, keeps the desk's tables; a rule
 * restores it in 15 minutes whatever happens) and restore — and the nudge: one message on the fleet's queue, so the
 * puller reads the origin now instead of on its schedule. Phase 6 adds the drills: the operator's CLI on the eu-west
 * host (policy show, rollback, unlock, status, doctor — a job the API hands itself; the CLI's own document lands on
 * the timeline and the newest answer is shown below the buttons), this host's own apply policy (an operator's act on
 * the SDK — the one loosening in the fleet; the daemon host's policy is its unit's flag), the golden set run now, and
 * the reset's clearing step. Phase 8 adds the steady state: **Wake the fleet** and **Sleep** (the eu-west host started
 * and stopped at EC2; the card reads waking / asleep since) and the **demo mode** switch (the eu-west workers' ticket
 * cadence: two minutes for four hours, then back to an hour on its own).
 * Every button is an API call; the result lands as a notice and on the timeline. The day's cap is read from the counter.
 *
 * @example
 * ```tsx
 * <Presenter state={state} busy={busy} selectedTicketId="T-1041" onAction={(action, body) => api.presenter(action, body)} environment="dev" agentId="agent_…" cliOutput={null} />
 * ```
 */
import type { State } from "../api";
import { TOOLTIPS, clock } from "../format";

export interface CliOutput { command: string; summary: string; document: unknown; stdout: string; status: string; at: string }

export function Presenter({ state, busy, selectedTicketId, onAction, environment, agentId, cliOutput }: { state: State | null; busy: string | null; selectedTicketId: string | null; onAction: (action: string, body?: Record<string, unknown>) => void; environment: string; agentId: string; cliOutput: CliOutput | null }) {
  const cap = state?.cap;
  const disabled = busy !== null;
  // "Run this ticket there now" is for hosts that run tickets: the daemon host. The puller pulls; the air-gapped host has no model.
  const others = (state?.hosts ?? []).filter((h) => h.kind === "daemon").map((h) => h.hostId);
  const wire = state?.features?.wire ?? false;
  const nudge = state?.features?.nudge ?? false;
  const hostCli = state?.features?.hostCli ?? false;
  const power = state?.features?.power ?? false;
  const demoMode = state?.features?.demoMode ?? false;
  const euPower = (state?.hosts ?? []).find((h) => h.kind === "daemon")?.powerView ?? null;
  const asleep = euPower !== null && euPower.phase !== "awake";
  const mode = state?.demoMode ?? null;
  const policy = state?.host.status?.applyPolicy as { effective?: string; source?: string } | undefined;
  return (
    <section className="presenter">
      <div className="pane-title"><h2>Presenter</h2><span className="muted" title={TOOLTIPS.cap}>{cap ? `${cap.used.toLocaleString()} / ${cap.cap.toLocaleString()} runs today` : "—"}</span></div>
      <div className="button-row">
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 5 })}>Replay 5</button>
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 12 })}>Replay 12</button>
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction("replay", { n: 30 })}>Replay 30</button>
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
      {power || demoMode ? (
        <div className="button-row" title={TOOLTIPS.power}>
          {power ? (
            <>
              <button type="button" className={`chip-button${asleep ? " done" : ""}`} disabled={disabled} onClick={() => onAction("wake_host")}>Wake the fleet</button>
              <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Put the eu-west host to sleep? Its daemon and workers stop (a ticket in flight there is lost); only its volume bills until you wake it. The nightly schedule does this by itself.")) onAction("sleep_host"); }}>Sleep</button>
              <span className="muted fine">eu-west: {euPower ? euPower.label : "—"}{euPower && euPower.phase !== "awake" && euPower.since ? ` since ${clock(euPower.since)}` : ""}</span>
            </>
          ) : null}
          {demoMode ? (
            <>
              <span className="muted fine" title={TOOLTIPS.demoMode}>· demo mode {mode ? mode.mode : "—"}{mode?.mode === "on" && mode.until ? ` until ${clock(mode.until)}` : ""}{mode?.reason && mode.reason !== "absent" ? ` (${mode.reason})` : ""}:</span>
              <button type="button" className={`chip-button${mode?.mode === "on" ? " done" : ""}`} disabled={disabled || mode?.mode === "on"} title={TOOLTIPS.demoMode} onClick={() => onAction("demo_mode", { value: "on" })}>on</button>
              <button type="button" className="chip-button" disabled={disabled || mode?.mode !== "on"} title={TOOLTIPS.demoMode} onClick={() => onAction("demo_mode", { value: "off" })}>off</button>
            </>
          ) : null}
        </div>
      ) : null}
      {hostCli ? (
        <div className="button-row" title={TOOLTIPS.hostCli}>
          <span className="muted fine">eu-west shell:</span>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("host_cli", { command: "policy show" })}>policy show</button>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("host_cli", { command: "status" })}>status</button>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("host_cli", { command: "doctor" })}>doctor</button>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("host_cli", { command: "unlock" })}>unlock</button>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Roll the eu-west host back to its previous release? A step below the stored generation is a forced downgrade the fleet page reports; the host is held back until something newer is promoted.")) onAction("host_cli", { command: "rollback" }); }}>rollback</button>
          <span className="muted fine">the answer lands on the timeline</span>
        </div>
      ) : null}
      {cliOutput ? (
        <div className="cli-output">
          <p className="fine"><strong>zudocs-cli {cliOutput.command}</strong> · {cliOutput.status} · {clock(cliOutput.at)} — {cliOutput.summary}</p>
          <pre className="output cli">{cliOutput.stdout.trim().slice(0, 4000) || "(no output)"}</pre>
        </div>
      ) : null}
      <div className="button-row" title={TOOLTIPS.policyLocal}>
        <span className="muted fine">this host: policy {policy?.effective ?? "—"} ({policy?.source ?? "—"})</span>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("policy", { value: "auto" })}>set auto</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("policy", { value: "unlock_required" })}>set unlock_required</button>
        <button type="button" className="chip-button" disabled={disabled} title={TOOLTIPS.golden} onClick={() => onAction("golden")}>Golden set now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Clear every run, feedback row, approval, timeline event and the day counters, and re-seed the inbox? This is the reset script's last step.")) onAction("reset"); }}>Reset records</button>
      </div>
      <p className="muted fine">AirPrompter {environment} · {agentId}{state ? ` · this container ${state.host.instanceId.slice(0, 12)} (${state.host.invocations} inv)` : ""}</p>
    </section>
  );
}
