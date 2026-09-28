/**
 * One line for the agent that writes support replies, and when AirPrompter last
 * changed the release it is running. The mix of an A|B test is not on this line.
 *
 * @example
 * ```tsx
 * <AgentLine state={state} events={events} />
 * ```
 */
import type { State, TimelineEvent } from "../api";
import { TOOLTIPS, ago, releaseSummary } from "../format";

export function AgentLine({ state, events }: { state: State | null; events: TimelineEvent[] }) {
  const summary = state ? releaseSummary(state.hosts) : null;
  const updated = [...events].reverse().find((event) => event.kind === "release_changed" || event.kind === "release_activated");
  return (
    <p className="agent-line" title={TOOLTIPS.release}>
      <strong>Support agent</strong>
      {summary?.generation != null ? <span> · release #{summary.generation}</span> : <span> · reading the release…</span>}
      {summary?.staged ? <span className="staged"> · update #{summary.staged.generation} waiting</span> : null}
      {updated ? <span> · updated from AirPrompter {ago(updated.at)}</span> : null}
    </p>
  );
}
