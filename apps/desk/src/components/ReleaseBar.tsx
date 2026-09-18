/**
 * The release bar: `release #N · active on X/Y hosts`, a staged generation when a host is waiting for approval,
 * and a red band carrying the refusal reason when a host refuses to render (a disable directive, a lapsed lease
 * under halt). Read from the status table — every host's own `status()` document — so it is the fleet's word,
 * not this tab's.
 *
 * @example
 * ```tsx
 * <ReleaseBar state={state} />
 * ```
 */
import type { State } from "../api";
import { TOOLTIPS, releaseSummary } from "../format";

export function ReleaseBar({ state }: { state: State | null }) {
  if (!state) return <div className="release muted">Reading the fleet…</div>;
  const s = releaseSummary(state.hosts);
  if (s.generation === null) return <div className="release muted">No host has reported yet.</div>;
  return (
    <div className={`release${s.refusal || s.failing ? " release-bad" : ""}`} title={TOOLTIPS.release}>
      <strong>release #{s.generation}</strong>
      <span>active on {s.activeOn}/{s.total} host{s.total === 1 ? "" : "s"}</span>
      {s.staged !== null ? <span className="staged">staged #{s.staged} awaiting approval</span> : null}
      {s.refusal ? <span className="refusal">refused: {s.refusal}</span> : null}
      {s.failing ? <span className="refusal">{s.failing} host{s.failing === 1 ? "" : "s"} failing</span> : null}
      <span className="muted">{state.airprompter.environment} · {state.airprompter.agentId}</span>
    </div>
  );
}
