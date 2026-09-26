/**
 * The daemon host, collapsed to the facts the daemon page is about: policy, store key, workers, and power.
 *
 * @example
 * ```tsx
 * <DaemonSummary host={hosts.find((h) => h.kind === "daemon") ?? null} />
 * ```
 */
import type { HostStatus } from "../api";
import { TOOLTIPS } from "../format";
import { Behind } from "./Behind";

export function DaemonSummary({ host, onBehind }: { host: HostStatus | null; onBehind?: (id: string) => void }) {
  if (!host) {
    return (
      <p className="muted daemon-missing">
        no daemon host has reported
        {onBehind ? <> · <Behind id="daemon-start" onOpen={onBehind} title={TOOLTIPS.daemon}>how the workers attach</Behind></> : null}
      </p>
    );
  }
  const status = host.status ?? {};
  const protection = String(status.storageProtection ?? "—");
  const power = host.powerView ?? null;
  const node = host.worker?.attached ? "node attached" : "node not attached";
  const python = host.python ? (host.python.attached ? "python attached" : "python not attached") : "python not reporting";
  return (
    <article className="host daemon-summary">
      <header>
        <strong>{host.region}</strong>
        <span className="muted" title={TOOLTIPS.daemon}>· the eu-west host</span>
        {power && power.phase !== "awake" ? <span className="chip health-asleep" title={TOOLTIPS.power}>{power.label}</span> : <span className={`chip health-${host.healthz?.status ?? "unknown"}`}>{host.healthz?.status ?? "—"}</span>}
      </header>
      <dl className="kv">
        <div><dt title={TOOLTIPS.approval}>policy</dt><dd>{status.applyPolicy?.effective ?? "—"} <span className="muted">({status.applyPolicy?.source ?? "—"})</span></dd></div>
        <div><dt title={TOOLTIPS.storage}>store key</dt><dd><span className={`chip protection-${protection}`}>{protection}</span></dd></div>
        <div><dt>workers</dt><dd>{node} · {python}</dd></div>
      </dl>
      {onBehind ? <p className="behind-row"><Behind id="policy-line" onOpen={onBehind} title={TOOLTIPS.approval}>why this host waits</Behind></p> : null}
    </article>
  );
}
