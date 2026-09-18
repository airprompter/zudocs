/**
 * The fleet: one card per host row in the status table — region and kind, the SDK, the release it serves and its
 * apply state, how its store key is protected (`kms` green, `file_key` amber — shown, never hidden), the policy and
 * where it comes from, the lease as a countdown, the last heartbeat (or, on the daemon host, the daemon's last
 * contact: the socket does not carry the heartbeat), the sync outcome and failures, the spool, the health verdict
 * with its reasons, and how long ago the row was written (a host that stopped writing fades). The daemon host also
 * shows its attached workers: the Node worker and the Python worker, each with its SDK and its count.
 *
 * @example
 * ```tsx
 * <HostCards state={state} />
 * ```
 */
import type { HostStatus, State } from "../api";
import { TOOLTIPS, ago, countdown } from "../format";

export function HostCards({ state }: { state: State | null }) {
  const hosts = [...(state?.hosts ?? [])].sort((a, b) => (a.hostId < b.hostId ? 1 : -1));
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
  const daemon = host.kind === "daemon";
  const failures = Number(s.consecutiveSyncFailures ?? 0);
  return (
    <article className={`host${stale ? " stale" : ""}${z.status === "degraded" ? " degraded" : ""}`}>
      <header>
        <strong>{host.region}</strong> <span className="muted" title={daemon ? TOOLTIPS.daemon : undefined}>· {daemon ? "daemon host" : host.kind}</span>
        <span className={`chip health-${z.status ?? "unknown"}`}>{z.status ?? "—"}</span>
      </header>
      <dl className="kv">
        <div><dt>release</dt><dd>#{s.generation ?? "—"} · {s.applyState ?? "—"}{s.stagedGeneration ? <span className="staged"> · staged #{s.stagedGeneration} awaiting approval</span> : ""}{s.forcedDowngrade ? <span className="refusal"> · forced downgrade</span> : ""}</dd></div>
        <div><dt title={TOOLTIPS.storage}>store key</dt><dd><span className={`chip protection-${protection}`}>{protection}</span>{protection === "file_key" ? <span className="muted"> · a 0600 file beside the store — doctor warns</span> : null}</dd></div>
        <div><dt title={daemon ? TOOLTIPS.approval : undefined}>policy</dt><dd>{s.applyPolicy?.effective ?? "—"} <span className="muted">({s.applyPolicy?.source ?? "—"}{s.applyPolicy?.manifestSaid && s.applyPolicy.manifestSaid !== s.applyPolicy.effective ? `; the console says ${s.applyPolicy.manifestSaid}` : ""})</span></dd></div>
        <div><dt title={TOOLTIPS.lease}>lease</dt><dd>{s.leaseExpiresAt ? `${countdown(s.leaseExpiresAt)} · until ${String(s.leaseExpiresAt).slice(11, 19)}Z` : "—"}{s.leaseExpired ? <span className="refusal"> · expired</span> : ""}</dd></div>
        {daemon
          ? <div><dt>contact</dt><dd>{ago(s.lastContactAt ?? null)} <span className="muted">· heartbeat by the daemon (not on its socket)</span></dd></div>
          : <div><dt>heartbeat</dt><dd>{ago(s.heartbeat?.lastAt ?? null)}{s.heartbeat?.lastRefusal ? ` · ${s.heartbeat.lastRefusal}` : ""}</dd></div>}
        <div><dt>sync</dt><dd>{s.lastSyncOutcome ?? "—"} · {ago(s.lastSyncAt ?? null)}{failures > 0 ? <span className={failures >= 3 ? "refusal" : "staged"}> · {failures} failure{failures === 1 ? "" : "s"} in a row</span> : ""}</dd></div>
        <div><dt>spool</dt><dd>{s.spool?.depthSegments ?? 0} seg · {s.spool?.depthBytes ?? 0} B{s.upload?.lastUploadAt ? ` · uploaded ${ago(s.upload.lastUploadAt)}` : ""}</dd></div>
        <div><dt>variables</dt><dd>{(s.variables?.sources ?? []).join(", ") || "none"}{(s.variables?.unsourced ?? []).length ? ` · unsourced: ${s.variables.unsourced.map((u: { tag: string; names: string[] }) => `${u.tag} ${u.names.join("/")}`).join("; ")}` : ""}</dd></div>
        <div><dt>sdk</dt><dd>{host.sdk}</dd></div>
        {daemon ? (
          <>
            <div><dt>workers</dt><dd>{host.worker ? `node ${host.worker.sdk} · ${host.worker.tickets} ticket${host.worker.tickets === 1 ? "" : "s"} · ${host.worker.attached ? "attached" : "detached"}` : "node worker not reporting"}</dd></div>
            <div><dt></dt><dd>{host.python ? `${host.python.sdk} · ${host.python.runs} run${host.python.runs === 1 ? "" : "s"} · ${host.python.attached ? "attached" : "detached"} · written ${ago(host.python.writtenAt)}` : "python worker not reporting"}</dd></div>
            <div><dt>instance</dt><dd>{host.ec2 ? `${host.ec2.instanceId} · ${host.ec2.availabilityZone}` : "—"} · daemon {host.container.instanceId.slice(0, 12)}</dd></div>
          </>
        ) : (
          <div><dt>container</dt><dd>{host.container.instanceId.slice(0, 12)} · {host.container.invocations} inv · {host.container.coldStart ? "cold" : "warm"}</dd></div>
        )}
      </dl>
      {z.reasons?.length ? <p className={z.status === "ok" ? "muted" : "problem fine"}>{z.reasons.join(", ")}</p> : null}
      <footer className="muted">written {ago(host.writtenAt)}</footer>
    </article>
  );
}
