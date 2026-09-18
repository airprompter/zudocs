/**
 * "Why this text": the prompt exactly as the SDK rendered it on this host, with every variable's value
 * highlighted by where it came from — the call site, the desk's own source, or the version's declared default —
 * the end-user fence shown around the customer's words, and the trust of each variable as a chip. The legend is
 * the vocabulary; the prompt's own instructions are the version's, sealed in AirPrompter.
 *
 * @example
 * ```tsx
 * <WhyThisText rendered={step.rendered} />
 * ```
 */
import type { Step } from "../api";
import { ORIGIN_LABELS, TOOLTIPS, segmentRender } from "../format";

export function WhyThisText({ rendered }: { rendered: NonNullable<Step["rendered"]> }) {
  const segments = segmentRender(rendered.text, rendered.variables);
  return (
    <div className="why">
      <div className="why-legend">
        {rendered.variables.map((v) => (
          <span key={v.name} className={`var-chip origin-${v.origin}`} title={TOOLTIPS.trust}>
            <code>{v.name}</code> · {ORIGIN_LABELS[v.origin]} · {v.trust === "end_user" ? "end-user" : "operator"}{v.fenced ? " · fenced" : ""}
          </span>
        ))}
        {rendered.inference ? <span className="var-chip origin-settings" title="The version's own model settings, applied by the SDK's wrapper on the call">settings · {Object.entries(rendered.inference).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("|") : String(v)}`).join(" · ")}</span> : null}
      </div>
      <pre className="why-text">
        {segments.map((s, i) => (s.variable ? <mark key={i} className={`origin-${s.variable.origin}${s.fence ? " fence" : ""}`} title={s.fence ? TOOLTIPS.fence : `${s.variable.name}: ${ORIGIN_LABELS[s.variable.origin]}`}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
      </pre>
    </div>
  );
}
