/**
 * Approvals: a release AirPrompter staged on a host under `unlock_required`, waiting for the owner. Each pending
 * row says which host, which release, when it was staged and the console's note when the host could read one; the
 * Approve button records the decision once (the API answers with the row as it stands on a repeat) and the host's
 * worker activates through its daemon — the row moves to "activated" with its instant, and the host card flips.
 * Settled rows stay in view for the session so a prospect sees the whole story: staged → approved → live. A
 * release that carries an experiment shows its ramp plan (read by the us-east host from the same signed manifest):
 * one approval here unlocks every step of the plan — the host walks it on its own clock, no check-in.
 *
 * @example
 * ```tsx
 * <Approvals approvals={approvals} busy={busy} onApprove={(id) => api.approve(id)} />
 * ```
 */
import type { Approval, Ramp } from "../api";
import { TOOLTIPS, ago, clock, slotShort } from "../format";

const pct = (bps: number) => `${Math.round(bps / 100)} %`;
/** The candidate arm's index in the manifest's arm order (control first by the platform's rule; found by name, not assumed). */
const candidateIndex = (arms: string[]) => Math.max(0, arms.indexOf("candidate"));
function RampLine({ ramps }: { ramps: Ramp[] | undefined }) {
  if (!ramps?.length) return null;
  return (
    <p className="fine ramp">
      {ramps.map((r) => <span key={r.experimentId}><strong>{r.tag ? slotShort(r.tag) : "every slot"} experiment</strong>: {r.arms.map((arm, i) => `${arm} ${pct(r.weightBps[i] ?? 0)}`).join(" · ")} · plan {r.plan.map((p) => pct(p.weightBps[candidateIndex(r.arms)] ?? 0)).join(" → ")} · </span>)}
      <span className="muted">one approval unlocks the whole plan; the host walks it on its own clock (read by {ramps[0]!.readBy ?? "us-east"} from the same signed manifest)</span>
    </p>
  );
}

const DECISION_LABEL: Record<Approval["decision"], string> = { pending: "awaiting your approval", approved: "approved — the host is activating", activated: "live", superseded: "settled on the host", failed: "the unlock was refused" };

export function Approvals({ approvals, busy, onApprove }: { approvals: Approval[]; busy: string | null; onApprove: (approvalId: string) => void }) {
  const pending = approvals.filter((a) => a.decision === "pending");
  const recent = approvals.filter((a) => a.decision !== "pending").slice(0, 3);
  if (approvals.length === 0) return null;
  return (
    <section className="approvals" title={TOOLTIPS.approval}>
      <div className="pane-title"><h2>Approvals</h2><span className="muted">{pending.length ? `${pending.length} staged` : "nothing waiting"}</span></div>
      {pending.map((a) => (
        <article key={a.approvalId} className="approval approval-pending">
          <div className="approval-head">
            <strong>release #{a.generation}</strong>
            <span className="staged">staged — {DECISION_LABEL[a.decision]} on {a.hostId}</span>
          </div>
          <p className="muted fine">staged {ago(a.stagedAt)} ({clock(a.stagedAt)}) · policy unlock_required on the host{a.unlockRequest ? ` · the console asks: “${a.unlockRequest.note ?? "unlock requested"}” (${a.unlockRequest.requestedBy}, until ${clock(a.unlockRequest.expiresAt)})` : " · no unlock request from the console on this release"}</p>
          <RampLine ramps={a.ramps} />
          <div className="button-row">
            <button type="button" className="button" disabled={busy !== null} onClick={() => onApprove(a.approvalId)}>Approve release #{a.generation} on {a.hostId}</button>
          </div>
        </article>
      ))}
      {recent.map((a) => (
        <article key={a.approvalId} className={`approval approval-${a.decision}`}>
          <div className="approval-head">
            <strong>release #{a.generation}</strong>
            <span className={`chip decision-${a.decision}`}>{DECISION_LABEL[a.decision]}</span>
            <span className="muted">{a.hostId}</span>
          </div>
          <p className="muted fine">
            staged {clock(a.stagedAt)}
            {a.decidedAt ? ` · approved ${clock(a.decidedAt)} by ${a.decidedBy ?? "the owner"}` : ""}
            {a.activatedAt ? ` · live ${clock(a.activatedAt)}` : ""}
            {a.outcome ? ` · ${a.outcome}` : ""}
          </p>
        </article>
      ))}
    </section>
  );
}
