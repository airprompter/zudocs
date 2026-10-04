/** The selected support host's release, with a quiet way to follow its path into a reply. */
import type { HostStatus, TimelineEvent } from "../api";
import { ago } from "../format";

export function AgentLine({ host, events, label, expanded, onJourney }: { host: HostStatus | null; events: TimelineEvent[]; label: string; expanded: boolean; onJourney: () => void }) {
  const active = Number(host?.status?.generation ?? 0);
  const staged = Number(host?.status?.stagedGeneration ?? 0);
  const applied = [...events].reverse().find((event) => event.host === host?.hostId && (!host?.container?.startedAt || event.at >= host.container.startedAt) && Number(event.generation) === active &&
    (event.kind === "release_activated" || (event.kind === "release_changed" && event.applyState === "active")));
  return (
    <p className="agent-line">
      <strong>{label}</strong>
      {active > 0 ? <span> · release #{active} on {host?.region}</span> : <span> · waiting for a release</span>}
      {staged > active ? <span className="staged"> · update #{staged} waiting for approval</span> : null}
      {applied ? <span> · applied {ago(applied.at)}</span> : host ? <span> · last reported {ago(host.writtenAt)}</span> : null}
      {host ? <button type="button" className="link journey-toggle" aria-expanded={expanded} onClick={onJourney}>{expanded ? "Hide release path" : "Follow release path"}</button> : null}
    </p>
  );
}
