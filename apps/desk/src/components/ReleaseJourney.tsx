/** A host-specific account of a signed release reaching one customer reply. */
import { isHostedRun, type AnyRun, type Approval, type HostStatus, type TimelineEvent } from "../api";
import { ago, clock, effectiveApplyState } from "../format";
import { IntegrationStatus } from "./IntegrationStatus";

export interface JourneyPhase { title: string; detail: string; at: string | null; state: "done" | "waiting" | "unknown" }
export interface JourneySnapshot { generation: number; active: number; fresh: boolean; phases: JourneyPhase[] }

export function journeySnapshot(host: HostStatus, approvals: Approval[], events: TimelineEvent[], runs: AnyRun[], ticketId: string | null, now = Date.now()): JourneySnapshot | null {
  const active = Number(host.status?.generation ?? 0);
  const staged = Number(host.status?.stagedGeneration ?? 0);
  const generation = Math.max(active, staged);
  if (generation < 1) return null;
  const fresh = now - Date.parse(host.writtenAt) < (host.kind === "lambda" ? 2 * 60 * 60_000 : 10 * 60_000);
  const matchingEvents = events.filter((event) => event.host === host.hostId && (!host.container?.startedAt || event.at >= host.container.startedAt) && Number(event.generation) === generation);
  const latest = (kind: string) => [...matchingEvents].reverse().find((event) => event.kind === kind);
  const approval = approvals.filter((row) => row.hostId === host.hostId && row.generation === generation).sort((a, b) => b.stagedAt.localeCompare(a.stagedAt))[0];
  const detected = latest("release_staged") ?? latest("release_changed");
  const applied = latest("release_activated") ?? [...matchingEvents].reverse().find((event) => event.kind === "release_changed" && event.applyState === "active");
  const serving = active === generation && effectiveApplyState(host.status ?? {}) === "active";
  // A daemon restart does not erase the reply's recorded release provenance.
  const proofSince = approval?.stagedAt ?? null;
  const matchingRuns = [...runs].filter((item) => !isHostedRun(item) && item.kind === "run" && item.host === host.hostId && item.generation === generation)
    .sort((a, b) => b.at.localeCompare(a.at));
  const run = matchingRuns.find((item) => !proofSince || item.at >= proofSince);
  const reply = run && !isHostedRun(run) ? run.steps.find((step) => step.step === "reply") : null;
  const earlier = !run ? matchingRuns[0] : null;
  const earlierReply = earlier && !isHostedRun(earlier) ? earlier.steps.find((step) => step.step === "reply") : null;
  const passed = reply?.checks.filter((check) => check.verdict === "pass").length ?? 0;
  const phases: JourneyPhase[] = [
    { title: "AirPrompter release", detail: `Signed release #${generation} is present in this host's report.`, at: null, state: "done" },
    { title: "Zudocs SDK", detail: detected ? `The ${host.region} host detected release #${generation}.` : approval ? `The ${host.region} host staged release #${generation} for approval.` : `The host reports release #${generation}; its detection time is unavailable.`, at: detected?.at ?? approval?.stagedAt ?? null, state: "done" },
  ];
  if (approval?.decision === "pending") phases.push({ title: "Host approval", detail: `Waiting for approval. Release #${active || "none"} remains in service.`, at: approval.stagedAt, state: "waiting" });
  else if (approval?.decision === "approved") phases.push({ title: "Host approval", detail: `Approved by ${approval.decidedBy ?? "an operator"}; the host has not reported activation yet.`, at: approval.decidedAt, state: "waiting" });
  else if (approval?.decision === "activated") phases.push({ title: "Host approval", detail: serving ? `Approved by ${approval.decidedBy ?? "an operator"} and activated on this host.` : "An earlier approval was recorded; this host has not reported the release active.", at: approval.activatedAt, state: serving ? "done" : "waiting" });
  else if (approval?.decision === "failed") phases.push({ title: "Host approval", detail: `Activation was refused: ${approval.outcome ?? "see the approval record"}.`, at: approval.decidedAt, state: "waiting" });
  else phases.push({ title: "Host policy", detail: serving ? "The host applied this release under its own policy." : "The host has not reported this release as active.", at: applied?.at ?? null, state: serving ? "done" : "waiting" });
  phases.push({ title: "Customer reply", detail: serving && reply?.output
    ? `${ticketId} was answered with ${reply.tag.replace(/^support\./, "")} ${reply.versionId ?? "an unreported version"}; ${passed}/${reply.checks.length} checks passed.`
    : !serving ? `This host still serves release #${active || "none"}. Run the ticket after activation to see the new reply.`
      : earlierReply?.output ? `${ticketId} has an earlier reply from release #${generation} on this host. It predates this approval; draft again to show this activation reaching the ticket.`
      : ticketId ? `Run ${ticketId} on this host to see a reply from release #${generation}.` : "Select a ticket to see its reply.",
  at: serving ? run?.at ?? earlier?.at ?? null : null, state: serving && reply?.output ? "done" : "waiting" });
  return { generation, active, fresh, phases };
}

export function ReleaseJourney({ host, approvals, events, runs, ticketId, onClose }: { host: HostStatus; approvals: Approval[]; events: TimelineEvent[]; runs: AnyRun[]; ticketId: string | null; onClose: () => void }) {
  const journey = journeySnapshot(host, approvals, events, runs, ticketId);
  return (
    <section className="release-journey" aria-label="Release path">
      <div className="release-journey-head">
        <div><span className="eyebrow">From AirPrompter to Zudocs</span><h2>{journey ? `Status, rollout and settings · ${host.region}` : `Waiting for a release on ${host.region}`}</h2></div>
        <button type="button" className="link" onClick={onClose}>Close</button>
      </div>
      {journey ? <>
        <IntegrationStatus host={host} runs={runs} />
        <h3 className="fine">Release #{journey.generation} path</h3>
        <ol className="journey-steps">
          {journey.phases.map((phase) => <li key={phase.title} className={`journey-${phase.state}`}>
            <span className="journey-mark" aria-hidden="true">{phase.state === "done" ? "✓" : phase.state === "waiting" ? "…" : "?"}</span>
            <div><strong>{phase.title}</strong><p>{phase.detail}</p>{phase.at ? <small>{clock(phase.at)} · {ago(phase.at)}</small> : null}</div>
          </li>)}
        </ol>
        <p className="journey-asof">{host.reportSource === "live" ? "Live SDK check" : journey.fresh ? "Host report" : "Last known host report"} from {ago(host.writtenAt)}. {host.kind === "lambda" ? "This function checks for a new release when the desk refreshes its status or runs a ticket." : "The Europe workers check for new releases in the background."} Times come from host and desk records; an event outside the recent timeline has no shown time.</p>
      </> : <p className="muted">The host has not reported a signed release yet.</p>}
    </section>
  );
}
