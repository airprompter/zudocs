/**
 * The timeline: every event a host appended — a container or worker starting, a release staged, approved and
 * activated (with the instant on each host, so us-east's auto-activation and eu-west's approval sit side by side),
 * a ticket run, feedback, a cap refusal, a health change, the wire cut or restored, a presenter action — newest
 * first, with the host that wrote it. Polled from the events table; rows are de-duplicated by the API's row id.
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
    case "host_started": return `${e.source === "daemon" ? "worker attached to the daemon" : "container started"} · release #${e.generation}${e.stagedGeneration ? ` (staged #${e.stagedGeneration})` : ""} · ${e.storageProtection} · policy ${e.applyPolicy}`;
    case "worker_started": return `${e.language ?? "worker"} worker attached · ${e.sdk} · release #${e.generation}`;
    case "worker_stopped": return `${e.language ?? "worker"} worker stopped${e.tickets !== undefined ? ` after ${e.tickets} tickets` : e.runs !== undefined ? ` after ${e.runs} runs` : ""}`;
    case "release_changed": return `release #${e.generation} ${e.applyState}${e.stagedGeneration ? ` · staged #${e.stagedGeneration}` : ""}${e.seenBy ? ` (seen by ${e.seenBy})` : ""}`;
    case "release_staged": return `release #${e.generation} staged — awaiting approval (policy ${e.policy})${e.note ? ` · console: ${e.note}` : ""}`;
    case "approval_decided": return `release #${e.generation} ${e.decision} for ${e.forHost} by ${e.by}`;
    case "release_activated": return `release #${e.generation} activated${e.by === "host" ? " on the host (unlock, window or rollback)" : ` on the desk's approval by ${e.by}`}`;
    case "release_unstaged": return `release #${e.generation} is live; the staged release went away`;
    case "approval_failed": return `release #${e.generation}: the unlock was refused — ${e.reason}`;
    case "health_changed": return `health ${e.status}${Array.isArray(e.reasons) && e.reasons.length ? `: ${(e.reasons as string[]).join(", ")}` : ""}${e.consecutiveSyncFailures ? ` · ${e.consecutiveSyncFailures} sync failures` : ""}`;
    case "wire": return `wire ${e.action === "cut" ? "cut" : "restored"}${e.forHost ? ` on ${e.forHost}` : ""} by ${e.by}${e.restoreBy ? ` · the rule restores by ${clock(String(e.restoreBy))}` : ""}`;
    case "ticket_run": return `${e.ticketId} run · ${e.versionId ?? "—"} on ${modelLabel(String(e.model ?? ""))}${e.arm && e.arm !== "none" ? ` · arm ${e.arm}` : ""}${e.sdk ? ` · ${e.sdk}` : ""}${e.ok ? "" : " · not every step answered"}`;
    case "ticket_escalated": return `${e.ticketId} escalated · ${e.versionId ?? "—"}`;
    case "feedback": return `feedback on ${e.ticketId}: ${(e.signals as string[]).join(", ")}${e.filed ? "" : " (refused)"}${String(e.by ?? "").includes("(checks)") ? " · from the checks" : ""}`;
    case "cap_refused": return `refused: ${e.used}/${e.cap} runs used on ${e.capDay ?? String(e.at).slice(0, 10)}`;
    case "presenter": return `presenter: ${e.action}${e.n ? ` ×${e.n}` : ""}${e.ticketId ? ` ${e.ticketId}` : ""}${e.forHost ? ` → ${e.forHost}` : ""}${e.outcome ? ` · ${e.outcome}` : ""}`;
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
            <li key={e.id ?? `${e.at}-${i}`} className={`event kind-${e.kind}`}>
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
