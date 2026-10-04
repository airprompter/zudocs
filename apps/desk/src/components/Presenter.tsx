/**
 * The system controls: a heartbeat / sync now, a re-seed of the inbox, the wire: cut (the eu-west host loses AirPrompter and Bedrock, keeps the desk's tables; a rule
 * restores it in 15 minutes whatever happens) and restore — and the nudge: one message on the fleet's queue, so the
 * puller reads the origin now instead of on its schedule. Phase 6 adds the drills: the operator's CLI on the eu-west
 * host (policy show, status, doctor — a job the API hands itself; the CLI's own document lands on
 * the timeline and the newest answer is shown below the buttons), read-only release policy, the golden set run now, and
 * the reset's clearing step. Phase 8 adds the steady state: **Wake the fleet** and **Sleep** (the eu-west host started
 * and stopped at EC2; the card reads waking / asleep since). Traffic controls live on Experiments;
 * upload controls live on Metrics.
 * Every button is an API call; the result lands as a notice and on the timeline. The day's cap is read from the counter.
 *
 * @example
 * ```tsx
 * <Presenter state={state} busy={busy} onAction={(action, body) => api.presenter(action, body)} environment="dev" agentId="agent_…" cliOutput={null} />
 * ```
 */
import type { State } from "../api";
import { Fold } from "./Fold";
import { TOOLTIPS, clock } from "../format";

export interface CliOutput { command: string; summary: string; document: unknown; stdout: string; status: string; at: string }

export function Presenter({ state, busy, onAction, environment, agentId, cliOutput }: { state: State | null; busy: string | null; onAction: (action: string, body?: Record<string, unknown>) => void; environment: string; agentId: string; cliOutput: CliOutput | null }) {
  const cap = state?.cap;

  const disabled = busy !== null || state === null;
  const wire = state?.features?.wire ?? false;
  const nudge = state?.features?.nudge ?? false;
  const hostCli = state?.features?.hostCli ?? false;
  const power = state?.features?.power ?? false;
  const euPower = (state?.hosts ?? []).find((h) => h.kind === "daemon")?.powerView ?? null;
  const asleep = euPower !== null && euPower.phase !== "awake";
  const policy = state?.host.status?.applyPolicy as { effective?: string; source?: string } | undefined;
  // Phase 9: the direct doors this deployment has keys for — each with its switch and what it has spent of its line.
  const doors = (["openai", "anthropic"] as const).filter((p) => state?.providers?.[p]?.configured);
  return (
    <section className="presenter">
      <div className="pane-title"><h2>Controls</h2><span className="muted" title={TOOLTIPS.cap}>{cap ? `${cap.used.toLocaleString()} / ${cap.cap.toLocaleString()} runs today` : "—"}</span></div>
      <Fold title="US desk function">
      <div className="button-row">
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("heartbeat")}>Heartbeat now</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("sync")}>Sync now</button>
      </div>
      {doors.length ? (
        <div className="button-row" title={TOOLTIPS.providerDoor}>
          <span className="muted fine">provider doors:</span>
          {doors.map((p) => {
            const row = state!.providers![p];
            const open = row.door?.open ?? false;
            return (
              <span key={p} className="door">
                <span className="muted fine">{row.label} {open ? "open" : `closed${row.door?.reason ? ` (${row.door.reason})` : ""}`} · {row.used ?? 0}/{row.cap ?? "—"} today:</span>
                <button type="button" className={`chip-button${open ? " done" : ""}`} disabled={disabled || open} onClick={() => onAction("provider_door", { provider: p, state: "on" })}>open</button>
                <button type="button" className="chip-button" disabled={disabled || !open} onClick={() => { if (confirm(`Close the ${row.label} door? Runs that name it answer 503 at once; the release's own model is unaffected.`)) onAction("provider_door", { provider: p, state: "off" }); }}>close</button>
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="button-row" title={TOOLTIPS.policyLocal}>
        <span className="muted fine">this host: policy {policy?.effective ?? "—"} ({policy?.source ?? "—"})</span>
        <button type="button" className="chip-button" disabled={disabled} title={TOOLTIPS.golden} onClick={() => onAction("golden")}>Golden set now</button>
      </div>
      </Fold>
      <Fold title="Europe workers">
      {wire ? (
        <div className="button-row" title={TOOLTIPS.wire}>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Cut the eu-west host's wire? AirPrompter and Bedrock go dark for it; the desk's tables stay; a rule restores it in 15 minutes.")) onAction("cut_wire"); }}>Cut the wire (eu-west)</button>
          <button type="button" className="chip-button" disabled={disabled} onClick={() => onAction("restore_wire")}>Restore the wire</button>
        </div>
      ) : null}
      {power ? (
        <div className="button-row" title={TOOLTIPS.power}>
          {power ? (
            <>
              <button type="button" className={`chip-button${asleep ? " done" : ""}`} disabled={disabled} onClick={() => onAction("wake_host")}>Wake the fleet</button>
              <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Put the eu-west host to sleep? Its daemon and workers stop (a ticket in flight there is lost); only its volume bills until you wake it. The nightly schedule does this by itself.")) onAction("sleep_host"); }}>Sleep</button>
              <span className="muted fine">eu-west: {euPower ? euPower.label : "—"}{euPower && euPower.phase !== "awake" && euPower.since ? ` since ${clock(euPower.since)}` : ""}</span>
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
          <span className="muted fine">the latest answer appears below; its activity record is in Database</span>
        </div>
      ) : null}
      {cliOutput ? (
        <div className="cli-output">
          <p className="fine"><strong>zudocs-cli {cliOutput.command}</strong> · {cliOutput.status} · {clock(cliOutput.at)} — {cliOutput.summary}</p>
          <pre className="output cli">{cliOutput.stdout.trim().slice(0, 4000) || "(no output)"}</pre>
        </div>
      ) : null}
      </Fold>
      <Fold title="Record maintenance">
      <div className="button-row">
        <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Re-seed the inbox? Tickets keep their ids; run headlines are cleared.")) onAction("seed"); }}>Re-seed</button>
        <button type="button" className="chip-button" disabled={disabled} onClick={() => { if (confirm("Clear every run, feedback row, approval, timeline event and the day counters, and re-seed the inbox? This is the reset script's last step.")) onAction("reset"); }}>Reset records</button>
      </div>
      </Fold>
      {nudge ? <Fold title="Release distribution"><div className="button-row"><button type="button" className="chip-button" disabled={disabled} title={TOOLTIPS.nudge} onClick={() => onAction("nudge")}>Check for a new release</button></div><p className="muted fine">Ask the distribution puller to check now. It still verifies the signed release.</p></Fold> : null}
      <p className="muted fine">AirPrompter {environment} · {agentId}{state ? ` · this container ${state.host.instanceId.slice(0, 12)} (${state.host.invocations} inv)` : ""}</p>
    </section>
  );
}
