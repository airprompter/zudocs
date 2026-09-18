/**
 * The release bar: `release #N · active on X/Y hosts`, a staged generation and the host waiting for approval, a
 * degraded count, and a red band carrying the refusal reason when a host refuses to render (a disable directive, a
 * lapsed lease under halt). A `network:` refusal whose poll has since succeeded is history (the SDK keeps it until
 * the next activation) and is shown muted. Read from the status table — every host's own `status()` document — so
 * it is the fleet's word, not this tab's.
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
      {s.staged ? <span className="staged">staged #{s.staged.generation} awaiting approval ({s.staged.hosts.join(", ")})</span> : null}
      {s.refusal ? <span className="refusal">refused: {s.refusal}</span> : null}
      {s.staleRefusal ? <span className="muted" title="The SDK keeps a network refusal until the next activation; the host's last poll succeeded.">last refusal: {s.staleRefusal} (cleared by the next activation)</span> : null}
      {s.failing ? <span className="refusal">{s.failing} host{s.failing === 1 ? "" : "s"} failing</span> : null}
      {s.degraded ? <span className="staged">{s.degraded} host{s.degraded === 1 ? "" : "s"} degraded</span> : null}
      {s.exchange !== null ? <span className="muted" title={TOOLTIPS.puller}>exchange holds #{s.exchange}</span> : null}
      <span className="muted">{state.airprompter.environment} · {state.airprompter.agentId}</span>
    </div>
  );
}
