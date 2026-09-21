/**
 * The timeline: every event a host appended — a container or worker starting, a release staged, approved and
 * activated (with the instant on each host, so us-east's auto-activation and eu-west's approval sit side by side),
 * a ticket run, feedback, a cap refusal, a health change, the wire cut or restored, the host put to sleep or woken
 * (and found so by the tick), demo mode switched, a presenter action, a bundle
 * pulled into the exchange, a nudge, the air-gapped host starting and applying, its exports and their import — newest
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
    case "release_unstaged": return e.replacedBy ? `release #${e.replacedBy} staged in place of the earlier staged release (its row is superseded; #${e.generation} stays live)` : `release #${e.generation} is live; the staged release went away`;
    case "approval_failed": return `release #${e.generation}: the unlock was refused — ${e.reason}`;
    case "health_changed": return `health ${e.status}${Array.isArray(e.reasons) && e.reasons.length ? `: ${(e.reasons as string[]).join(", ")}` : ""}${e.consecutiveSyncFailures ? ` · ${e.consecutiveSyncFailures} sync failures` : ""}`;
    case "wire": return `wire ${e.action === "cut" ? "cut" : "restored"}${e.forHost ? ` on ${e.forHost}` : ""} by ${e.by}${e.restoreBy ? ` · the rule restores by ${clock(String(e.restoreBy))}` : ""}`;
    case "power": return e.refusal ? `${e.action === "sleep" ? "sleep" : e.action === "wake" ? "wake" : "power"} refused on ${e.forHost}: ${e.refusal} (${e.by})` : e.observed ? `${e.forHost} found ${e.state} (${e.by === "the tick" || e.by === "the desk" ? `seen by ${e.by}` : `the ${e.state === "stopped" ? "sleep" : "wake"} begun by ${e.by}`})` : `${e.forHost} ${e.state === "stopping" ? "going to sleep" : e.state === "pending" ? "waking" : String(e.state)}${e.instanceId ? ` (${e.instanceId})` : ""} by ${e.by}`;
    case "demo_mode": return `demo mode ${e.mode}${e.until ? ` until ${clock(String(e.until))}` : ""} by ${e.by} · the eu-west workers read it within a minute`;
    case "ticket_run": return `${e.ticketId} run · ${e.versionId ?? "—"} on ${modelLabel(String(e.model ?? ""))}${e.arm && e.arm !== "none" ? ` · arm ${e.arm}` : ""}${e.sdk ? ` · ${e.sdk}` : ""}${e.ok ? "" : " · not every step answered"}`;
    case "ticket_escalated": return `${e.ticketId} escalated · ${e.versionId ?? "—"}`;
    case "feedback": return `feedback on ${e.ticketId}: ${(e.signals as string[]).join(", ")}${e.filed ? "" : " (refused)"}${String(e.by ?? "").includes("(checks)") ? " · from the checks" : ""}`;
    case "cap_refused": return `refused: ${e.used}/${e.cap} runs used on ${e.capDay ?? String(e.at).slice(0, 10)}`;
    case "presenter": return `presenter: ${e.action === "sleep_host" ? "sleep" : e.action === "wake_host" ? "wake the fleet" : e.action}${e.n ? ` ×${e.n}` : ""}${e.ticketId ? ` ${e.ticketId}` : ""}${e.forHost ? ` → ${e.forHost}` : ""}${e.outcome ? ` · ${e.outcome}` : ""}${e.action === "nudge" ? " → the fleet's queue" : ""}`;
    case "replay_done": return `replay done: ${e.done}/${e.requested}`;
    case "run_refused": return `${e.ticketId} refused — frozen: ${e.reason}`;
    case "hosted_run": return `${e.ticketId} on hosted ${e.target}: ${e.ok ? `${e.versionId ?? "—"} on ${modelLabel(String(e.model ?? ""))}${e.arm && e.arm !== "none" ? ` · arm ${e.arm}` : ""} · ${e.deltas} deltas · compat ${e.compatStatus}` : `refused (${e.refusal ?? "compat " + String(e.compatStatus)})`}`;
    case "host_cli": return `zudocs-cli ${e.command} on ${e.forHost}: ${e.status} — ${e.summary}${e.durationMs ? ` (${Math.round(Number(e.durationMs) / 1000)} s)` : ""}`;
    case "policy_set": return `policy ${e.before} → ${e.after} (${e.source}) by ${e.by}`;
    case "golden_run": return `golden sets on release #${e.generation}: ${(e.reports as Array<{ tag: string; passed: number; cases: number; met: boolean }>).map((r) => `${r.tag} ${r.passed}/${r.cases}${r.met ? "" : " BELOW the floor"}`).join("; ")}`;
    case "bundle_pulled": return `release #${e.generation} pulled into the exchange${e.sealed ? ` · sealed to key ${String(e.keyId).slice(0, 8)}…` : " · plaintext (dev)"} · ${e.trigger === "nudge" ? "on a nudge" : e.trigger === "reseal" ? "re-sealed to the host's new key" : "on the schedule"}${e.previous ? ` (was #${e.previous})` : ""}`;
    case "pull_failed": return `pull ${e.outcome}: ${e.reason}${e.detail ? ` — ${e.detail}` : ""}`;
    case "pull_conflict": return `generation #${e.generation} answered with another digest; the exchange keeps its row`;
    case "nudged": return `nudged by ${e.by}: the puller reads the origin now`;
    case "airgap_started": return `air-gapped runtime started${e.instanceId ? ` on ${e.instanceId}` : ""}${e.keyId ? ` · key ${String(e.keyId).slice(0, 8)}…` : ""} · ${e.phase}`;
    case "distribution_key_born": return `distribution key ${String(e.keyId).slice(0, 8)}… born on the host; the public half ${e.published ? "is in the exchange" : "is not in the exchange yet"}`;
    case "airgap_applied": return `air-gapped host: release #${e.generation ?? "—"} ${e.outcome}${e.reason ? ` (${e.reason})` : ""} · from ${e.source === "vendored" ? "the vendored bundle" : "the exchange"}`;
    case "telemetry_exported": return `telemetry exported: ${e.segments} segment${e.segments === 1 ? "" : "s"} (${e.instances} instance${e.instances === 1 ? "" : "s"}) → the exchange`;
    case "telemetry_imported": return `telemetry ${e.outcome}: ${e.uploaded ?? 0}/${e.segments ?? 0} segment${e.segments === 1 ? "" : "s"} for ${Array.isArray(e.instances) ? (e.instances as string[]).length : 0} offline instance${Array.isArray(e.instances) && (e.instances as string[]).length === 1 ? "" : "s"} → AirPrompter${e.retryAfterSeconds ? ` · retry in ${e.retryAfterSeconds}s` : ""}`;
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
