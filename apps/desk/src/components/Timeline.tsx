/**
 * The timeline: every event a host appended — a container starting, a release landing, a ticket run, feedback,
 * a cap refusal, a presenter action — newest first, with the host that wrote it. Polled from the events table.
 *
 * @example
 * ```tsx
 * <Timeline events={events} />
 * ```
 */
import type { TimelineEvent } from "../api";
import { clock, modelLabel } from "../format";

function describe(e: TimelineEvent): string {
  switch (e.kind) {
    case "host_started": return `container started · release #${e.generation} · ${e.storageProtection} · policy ${e.applyPolicy}`;
    case "release_changed": return `release #${e.generation} ${e.applyState}${e.stagedGeneration ? ` · staged #${e.stagedGeneration}` : ""}`;
    case "ticket_run": return `${e.ticketId} run · ${e.versionId ?? "—"} on ${modelLabel(String(e.model ?? ""))}${e.arm && e.arm !== "none" ? ` · arm ${e.arm}` : ""}${e.ok ? "" : " · not every step answered"}`;
    case "ticket_escalated": return `${e.ticketId} escalated · ${e.versionId ?? "—"}`;
    case "feedback": return `feedback on ${e.ticketId}: ${(e.signals as string[]).join(", ")}${e.filed ? "" : " (refused)"}`;
    case "cap_refused": return `refused: ${e.used}/${e.cap} runs used on ${e.day}`;
    case "presenter": return `presenter: ${e.action}${e.n ? ` ×${e.n}` : ""}${e.outcome ? ` · ${e.outcome}` : ""}`;
    case "replay_done": return `replay done: ${e.done}/${e.requested}`;
    default: return e.kind;
  }
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  const newest = [...events].reverse();
  return (
    <section className="timeline">
      <div className="pane-title"><h2>Timeline</h2><span className="muted">{events.length} today</span></div>
      {newest.length === 0 ? <p className="muted">Nothing yet today.</p> : (
        <ol>
          {newest.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`event kind-${e.kind}`}>
              <span className="event-time">{clock(e.at)}</span>
              <span className="event-host">{e.host}</span>
              <span className="event-text">{describe(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
