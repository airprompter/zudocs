/**
 * The experiments panel (beat 4): the ramp plans this host walks (each experiment's slot, the weights in force, the
 * step, the plan's next instant), then the per-arm results the API folded from the desk's own records — runs by
 * host, the judge's mean, the mean cost at list price, checks, feedback — and the stickiness table: for every
 * customer that saw an experiment, the arm each host landed them on, and whether every host agreed (they must: the
 * arm is a hash of the manifest's salt and the customer id, computed on each host with no coordination). Nothing
 * here is computed by the app; it renders the API's fold, and says when there is nothing to fold yet.
 *
 * @example
 * ```tsx
 * <Experiments arms={arms} />
 * ```
 */
import type { Arms } from "../api";
import { TOOLTIPS, ago, armLabel, countdown, latency, modelLabel, money, slotShort } from "../format";

const pct = (bps: number) => `${Math.round(bps / 100)} %`;
/** The candidate arm's index in the manifest's arm order (control first by the platform's rule; found by name, not assumed). */
const candidateIndex = (arms: string[]) => Math.max(0, arms.indexOf("candidate"));

export function Experiments({ arms }: { arms: Arms | null }) {
  if (!arms) return null;
  const live = arms.arms.filter((a) => a.arm !== "none");
  if (arms.ramps.length === 0 && live.length === 0) return null;
  const multiHost = arms.stickiness.filter((s) => Object.keys(s.arms).length > 1);
  const inconsistent = multiHost.filter((s) => !s.consistent);
  return (
    <section className="experiments" title={TOOLTIPS.arm}>
      <div className="pane-title"><h2>Experiments</h2><span className="muted">{arms.ramps.length ? `${arms.ramps.length} live on this host` : "no experiment on the release; results below are history"} · read {ago(arms.readAt)}</span></div>
      {arms.ramps.map((r) => (
        <p key={r.experimentId} className="fine">
          <strong>{r.tag ? slotShort(r.tag) : "every slot"}</strong>: {r.arms.map((arm, i) => `${arm} ${pct(r.weightBps[i] ?? 0)}`).join(" · ")}
          <span className="muted"> · plan {r.plan.map((p, i) => `${i === r.step ? "▶ " : ""}${pct(p.weightBps[candidateIndex(r.arms)] ?? 0)}`).join(" → ")}{r.nextStepAt ? ` · next step ${countdown(r.nextStepAt).replace(/^expired (.*) ago$/, "due $1 ago")}` : ""} · one approval unlocks the whole plan on eu-west</span>
        </p>
      ))}
      {live.length ? (
        <div className="scroll-x">
          <table className="arms">
            <thead><tr><th>slot</th><th>arm</th><th>version</th><th>model</th><th>runs</th><th>hosts</th><th>judge</th><th>cost / run</th><th>latency</th><th>checks</th><th>feedback</th></tr></thead>
            <tbody>
              {live.map((a) => (
                <tr key={`${a.tag}|${a.arm}|${a.versionId}`} className={`arm-row arm-${a.arm}`}>
                  <td>{slotShort(a.tag)}</td>
                  <td><span className={`badge arm${a.arm !== "none" ? " arm-live" : ""}`}>{armLabel(a.arm)}</span></td>
                  <td>{a.versionId}</td>
                  <td>{modelLabel(a.model)}</td>
                  <td>{a.runs}</td>
                  <td className="muted fine">{Object.entries(a.hosts).map(([h, n]) => `${h.split("/")[0]} ${n}`).join(" · ")}</td>
                  <td>{a.judgeMean === null ? "—" : `${Math.round(a.judgeMean * 100)} % (${a.judged})`}</td>
                  <td>{money(a.costMeanUsd)}</td>
                  <td>{latency(a.latencyMeanMs)}</td>
                  <td>{a.checksPassed}✓ {a.checksFailed ? `${a.checksFailed}✗` : ""}</td>
                  <td>👍 {a.feedback.up} 👎 {a.feedback.down}{a.feedback.accepted ? ` · sent ${a.feedback.accepted}` : ""}{a.feedback.edited ? ` · edited ${a.feedback.edited}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted fine">No run on an arm yet — Replay 30, or run a ticket on eu-west.</p>}
      {arms.stickiness.length ? (
        <p className="fine">
          <strong>Sticky by customer:</strong> {arms.stickiness.length} customer·experiment pairs across {new Set(arms.stickiness.flatMap((s) => Object.keys(s.arms))).size} host(s); {multiHost.length} seen on more than one host — {multiHost.length === 0 ? "nothing to compare yet" : inconsistent.length === 0 ? "every host agrees" : `${inconsistent.length} DISAGREE`}.
          <span className="muted"> {arms.stickiness.filter((s) => Object.keys(s.arms).length > 1).slice(0, 12).map((s) => `${s.customerId} ${slotShort(s.tag)}: ${Object.entries(s.arms).map(([h, a]) => `${h.split("/")[0]} ${a}`).join(" = ")}`).join(" · ")}</span>
        </p>
      ) : null}
    </section>
  );
}
