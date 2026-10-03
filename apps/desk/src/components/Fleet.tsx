/**
 * The signed-out fleet: the three offices as operational cards. Live chips
 * are absent; a quiet link on each card opens how that host starts.
 *
 * @example
 * ```tsx
 * <Fleet onBehind={(id) => openSheet(id)} note="sign in to read the live rows" />
 * ```
 */
import { TOOLTIPS } from "../format";
import { Behind } from "./Behind";

export function Fleet({ onBehind, note }: { onBehind: (id: string) => void; note: string }) {
  return (
    <section className="hosts fleet">
      <div className="pane-title"><h2>Hosts</h2><span className="muted">{note}</span></div>
      <article className="host">
        <header><strong>us-east-1</strong> <span className="muted">· this account’s function</span></header>
        <p className="fine">Runs the ticket on each request. Policy auto. Store key under KMS.</p>
        <p className="behind-row"><Behind id="lambda-start" onOpen={onBehind} title={TOOLTIPS.release}>how this function starts</Behind></p>
      </article>
      <article className="host">
        <header><strong>eu-west-1</strong> <span className="muted" title={TOOLTIPS.daemon}>· the eu-west host</span></header>
        <p className="fine">Each host loads its own release. The daemon ships telemetry. A staged release waits for a person.</p>
        <p className="behind-row"><Behind id="daemon-start" onOpen={onBehind} title={TOOLTIPS.daemon}>how this host runs</Behind></p>
      </article>
      <article className="host">
        <header><strong>No route out</strong> <span className="muted" title={TOOLTIPS.airgap}>· air-gapped host</span></header>
        <p className="fine">Reads what the puller sealed. Every render it files is a refusal.</p>
        <p className="behind-row"><Behind id="airgap-start" onOpen={onBehind} title={TOOLTIPS.airgap}>how this host starts offline</Behind></p>
      </article>
    </section>
  );
}
