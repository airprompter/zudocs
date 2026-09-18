/**
 * The fleet: one card per host row in the status table — region and kind, the SDK, the release it serves and its
 * apply state, how its store key is protected (`kms` green, `file_key` amber — shown, never hidden), the lease,
 * the last heartbeat, the spool, the health verdict, and how long ago the row was written (a host that stopped
 * writing fades). Phase 3 has one host; phases 4 and 5 add the daemon host and the air-gapped one.
 *
 * @example
 * ```tsx
 * <HostCards state={state} />
 * ```
 */
import type { HostStatus, State } from "../api";
import { TOOLTIPS, ago } from "../format";

export function HostCards({ state }: { state: State | null }) {
  const hosts = state?.hosts ?? [];
  return (
    <section className="hosts">
      <div className="pane-title"><h2>Hosts</h2><span className="muted">{hosts.length} reporting</span></div>
      {hosts.length === 0 ? <p className="muted">No host has written its status yet — run a ticket.</p> : hosts.map((h) => <HostCard key={h.hostId} host={h} />)}
    </section>
  );
}

function HostCard({ host }: { host: HostStatus }) {
  const s = host.status;
  const z = host.healthz;
  const stale = Date.now() - Date.parse(host.writtenAt) > 10 * 60_000;
  const protection = String(s.storageProtection ?? "—");
  return (
    <article className={`host${stale ? " stale" : ""}`}>
      <header>
        <strong>{host.region}</strong> <span className="muted">· {host.kind}</span>
        <span className={`chip health-${z.status ?? "unknown"}`}>{z.status ?? "—"}</span>
      </header>
      <dl className="kv">
        <div><dt>release</dt><dd>#{s.generation ?? "—"} · {s.applyState ?? "—"}{s.stagedGeneration ? ` · staged #${s.stagedGeneration}` : ""}</dd></div>
        <div><dt title={TOOLTIPS.storage}>store key</dt><dd><span className={`chip protection-${protection}`}>{protection}</span></dd></div>
        <div><dt>policy</dt><dd>{s.applyPolicy?.effective ?? "—"} <span className="muted">({s.applyPolicy?.source ?? "—"})</span></dd></div>
        <div><dt>lease</dt><dd>{s.leaseExpiresAt ? `until ${String(s.leaseExpiresAt).slice(11, 19)}Z` : "—"}{s.leaseExpired ? " · expired" : ""}</dd></div>
        <div><dt>heartbeat</dt><dd>{ago(s.heartbeat?.lastAt ?? null)}{s.heartbeat?.lastRefusal ? ` · ${s.heartbeat.lastRefusal}` : ""}</dd></div>
        <div><dt>sync</dt><dd>{s.lastSyncOutcome ?? "—"} · {ago(s.lastSyncAt ?? null)}</dd></div>
        <div><dt>spool</dt><dd>{s.spool?.depthSegments ?? 0} seg · {s.spool?.depthBytes ?? 0} B</dd></div>
        <div><dt>variables</dt><dd>{(s.variables?.sources ?? []).join(", ") || "none"}{(s.variables?.unsourced ?? []).length ? ` · unsourced: ${s.variables.unsourced.map((u: { tag: string; names: string[] }) => `${u.tag} ${u.names.join("/")}`).join("; ")}` : ""}</dd></div>
        <div><dt>sdk</dt><dd>{host.sdk}</dd></div>
        <div><dt>container</dt><dd>{host.container.instanceId.slice(0, 12)} · {host.container.invocations} inv · {host.container.coldStart ? "cold" : "warm"}</dd></div>
      </dl>
      {z.reasons?.length ? <p className="muted">{z.reasons.join(", ")}</p> : null}
      <footer className="muted">written {ago(host.writtenAt)}</footer>
    </article>
  );
}
