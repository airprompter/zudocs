/**
 * The live test: the mix in force, the plan that turns the new reply up, the
 * scorecard the API folded from the desk's own records, and whether every
 * office gave the same customer the same reply. Nothing here is computed by
 * the app. When the release carries no test, the board stays up so the room
 * can see where a later mix will land.
 *
 * @example
 * ```tsx
 * <Experiments arms={arms} />
 * ```
 */
import type { Arms } from "../api";
import { TOOLTIPS, ago, armLabel, countdown, latency, modelLabel, money, slotShort } from "../format";

const pct = (bps: number) => Math.round(bps / 100);
/** The candidate arm's index in the manifest's arm order (control first by the platform's rule; found by name, not assumed). */
const candidateIndex = (arms: string[]) => Math.max(0, arms.indexOf("candidate"));

export function Experiments({ arms }: { arms: Arms | null }) {
  if (!arms) return (
    <section className="experiments" title={TOOLTIPS.arm}>
      <div className="pane-title"><h2>The live test</h2><span className="muted">Reading the mix…</span></div>
    </section>
  );
  if (!arms.arms || !arms.ramps || !arms.stickiness) return null;
  const live = arms.arms.filter((a) => a.arm !== "none");
  const idle = arms.ramps.length === 0 && live.length === 0;
  const multiHost = arms.stickiness.filter((s) => Object.keys(s.arms).length > 1);
  const inconsistent = multiHost.filter((s) => !s.consistent);
  const generations = [...new Set(arms.stickiness.map((s) => s.generation).filter((g): g is number => g !== null))].sort((a, b) => a - b);
  const latest = generations.at(-1) ?? null;
  const earlier = latest === null ? 0 : arms.stickiness.filter((s) => s.generation !== latest).length;
  return (
    <section className="experiments" title={TOOLTIPS.arm}>
      <div className="pane-title"><h2>The live test</h2><span className="muted">{idle ? "no test on this release" : arms.ramps.length ? "on this release" : "history — no test on this release"} · read {ago(arms.readAt)}</span></div>
      {idle ? <p className="muted fine">No A|B test is on this release. When one is, the mix, the plan, and the scorecard appear here.</p> : null}
      {idle ? null : arms.ramps.map((r) => {
        const newPct = pct(r.weightBps[candidateIndex(r.arms)] ?? 0);
        return (
          <div key={r.experimentId} className="mix">
            <p className="fine"><strong>{r.tag ? slotShort(r.tag) : "the reply"}</strong>: {100 - newPct}% current reply · {newPct}% new reply</p>
            <meter className="mix-meter" min={0} max={100} value={newPct}>{newPct}% new reply</meter>
            <p className="muted fine">
              The plan turns the new reply up: {r.plan.map((p, i) => `${i === r.step ? "now " : ""}${pct(p.weightBps[candidateIndex(r.arms)] ?? 0)}%`).join(" → ")}
              {r.nextStepAt ? ` · next step ${countdown(r.nextStepAt).replace(/^expired (.*) ago$/, "due $1 ago")}` : ""}
              {" "}· one approval unlocks the whole plan on the eu-west host
            </p>
          </div>
        );
      })}
      {live.length ? (
        <div className="scroll-x">
          <table className="arms">
            <thead><tr><th>which prompt</th><th>which reply</th><th>version</th><th>model</th><th>runs</th><th>offices</th><th>quality</th><th>cost / run</th><th>latency</th><th>checks</th><th>thumbs</th></tr></thead>
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
                  <td>{a.checksPassed} pass{a.checksFailed ? ` · ${a.checksFailed} fail` : ""}</td>
                  <td>up {a.feedback.up} · down {a.feedback.down}{a.feedback.accepted ? ` · sent ${a.feedback.accepted}` : ""}{a.feedback.edited ? ` · edited ${a.feedback.edited}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          ) : idle ? null : <p className="muted fine">No run on a test yet.</p>}
      {!idle && arms.stickiness.length ? (
        <p className="fine">
          <strong>Same customer, every office:</strong> {multiHost.length === 0 ? "no customer has been seen on more than one host under this mix yet" : inconsistent.length === 0 ? "every office gave the same customer the same reply" : `${inconsistent.length} offices disagreed`}.
          {earlier > 0 ? <span className="muted"> {earlier} row(s) are from before release #{latest} — turning the dial moves some customers onto the new reply by design.</span> : null}
          <span className="muted"> {multiHost.slice(0, 12).map((s) => `${s.customerId} ${slotShort(s.tag)}${s.generation !== null ? ` #${s.generation}` : ""}: ${Object.entries(s.arms).map(([h, a]) => `${h.split("/")[0]} ${armLabel(a)}`).join(" = ")}`).join(" · ")}</span>
        </p>
      ) : null}
    </section>
  );
}
