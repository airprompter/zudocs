/**
 * The fleet: one card per host row in the status table — region and kind, the SDK, the release it serves and its
 * apply state, how its store key is protected (`kms` green, `file_key` amber — shown, never hidden), the policy and
 * where it comes from, the lease as a countdown, the last heartbeat (or, on the daemon host, the daemon's last
 * contact: the socket does not carry the heartbeat), the sync outcome and failures, the spool, the health verdict
 * with its reasons, and how long ago the row was written (a host that stopped writing fades). The daemon host also
 * shows its attached workers and its import timer; the puller shows what the exchange holds and what its pulls cost;
 * the air-gapped host shows that it has no route out, the key born on it, what it applied from the exchange, its
 * render probes (every one a refused observation — no model here) and its exports.
 *
 * @example
 * ```tsx
 * <HostCards state={state} />
 * ```
 */
import type { HostStatus, State } from "../api";
import { TOOLTIPS, ago, countdown, effectiveApplyState, staleRefusal } from "../format";

export function HostCards({ state }: { state: State | null }) {
  const hosts = [...(state?.hosts ?? [])].sort((a, b) => (a.hostId < b.hostId ? 1 : -1));
  return (
    <section className="hosts">
      <div className="pane-title"><h2>Hosts</h2><span className="muted">{hosts.length} reporting</span></div>
      {hosts.length === 0 ? <p className="muted">No host has written its status yet — run a ticket.</p> : hosts.map((h) => (h.kind === "puller" ? <PullerCard key={h.hostId} host={h} /> : h.kind === "airgapped" ? <AirgapCard key={h.hostId} host={h} /> : <HostCard key={h.hostId} host={h} />))}
    </section>
  );
}

const shortKey = (keyId: string | null | undefined): string => (keyId ? `${keyId.slice(0, 8)}…` : "—");

function HostCard({ host }: { host: HostStatus }) {
  // A row written while the daemon was unreachable carries a health verdict and no status block: render what is there.
  const s = host.status ?? {};
  const z = host.healthz ?? {};
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
        <div><dt>release</dt><dd>#{s.generation ?? "—"} · {effectiveApplyState(s) ?? "—"}{s.stagedGeneration ? <span className="staged"> · staged #{s.stagedGeneration} awaiting approval</span> : ""}{s.forcedDowngrade ? <span className="refusal"> · forced downgrade</span> : ""}{s.lastRefusal && !staleRefusal(s) ? <span className="refusal"> · refused: {s.lastRefusal}</span> : ""}</dd></div>
        <div><dt title={TOOLTIPS.storage}>store key</dt><dd><span className={`chip protection-${protection}`}>{protection}</span>{protection === "file_key" ? <span className="muted"> · a 0600 file beside the store — doctor warns</span> : null}</dd></div>
        <div><dt title={daemon ? TOOLTIPS.approval : undefined}>policy</dt><dd>{s.applyPolicy?.effective ?? "—"} <span className="muted">({s.applyPolicy?.source ?? "—"}{s.applyPolicy?.manifestSaid && s.applyPolicy.manifestSaid !== s.applyPolicy.effective ? `; the console says ${s.applyPolicy.manifestSaid}` : ""})</span></dd></div>
        <div><dt title={TOOLTIPS.lease}>lease</dt><dd>{s.leaseExpiresAt ? `${countdown(s.leaseExpiresAt)} · until ${String(s.leaseExpiresAt).slice(11, 19)}Z` : "—"}{s.leaseExpired ? <span className="refusal"> · expired</span> : ""}</dd></div>
        {daemon
          ? <div><dt>contact</dt><dd>{ago(s.lastContactAt ?? null)} <span className="muted">· heartbeat by the daemon (not on its socket)</span></dd></div>
          : <div><dt>heartbeat</dt><dd>{ago(s.heartbeat?.lastAt ?? null)}{s.heartbeat?.lastRefusal ? ` · ${s.heartbeat.lastRefusal}` : ""}</dd></div>}
        <div><dt>sync</dt><dd>{s.lastSyncOutcome ?? "—"} · {ago(s.lastSyncAt ?? null)}{failures > 0 ? <span className={failures >= 3 ? "refusal" : "staged"}> · {failures} failure{failures === 1 ? "" : "s"} in a row</span> : ""}{staleRefusal(s) ? <span className="muted"> · last refusal {s.lastRefusal} (cleared by the next activation)</span> : ""}</dd></div>
        <div><dt>spool</dt><dd>{s.spool?.depthSegments ?? 0} seg · {s.spool?.depthBytes ?? 0} B{s.upload?.lastUploadAt ? ` · uploaded ${ago(s.upload.lastUploadAt)}` : ""}</dd></div>
        <div><dt>variables</dt><dd>{(s.variables?.sources ?? []).join(", ") || "none"}{(s.variables?.unsourced ?? []).length ? ` · unsourced: ${s.variables.unsourced.map((u: { tag: string; names: string[] }) => `${u.tag} ${u.names.join("/")}`).join("; ")}` : ""}</dd></div>
        <div><dt>sdk</dt><dd>{host.sdk}</dd></div>
        {daemon ? (
          <>
            <div><dt>workers</dt><dd>{host.worker ? `node ${host.worker.sdk} · ${host.worker.tickets} ticket${host.worker.tickets === 1 ? "" : "s"} · ${host.worker.attached ? "attached" : "detached"}` : "node worker not reporting"}</dd></div>
            <div><dt></dt><dd>{host.python ? `${host.python.sdk} · ${host.python.runs} run${host.python.runs === 1 ? "" : "s"} · ${host.python.attached ? "attached" : "detached"} · written ${ago(host.python.writtenAt)}` : "python worker not reporting"}</dd></div>
            <div><dt title={TOOLTIPS.airgap}>imports</dt><dd>{host.imports ? `${host.imports.objects} export${host.imports.objects === 1 ? "" : "s"} in the exchange · ${host.imports.pending} pending · last pass ${ago(host.imports.lastPassAt)}${host.imports.last ? ` · last ${String(host.imports.last.outcome)} (${String(host.imports.last.uploaded ?? 0)} segment${Number(host.imports.last.uploaded ?? 0) === 1 ? "" : "s"})` : ""}` : "the import timer has not run yet"}</dd></div>
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

function PullerCard({ host }: { host: HostStatus }) {
  const s = host.status ?? {};
  const z = host.healthz ?? {};
  const stale = Date.now() - Date.parse(host.writtenAt) > 15 * 60_000;
  const last = s.lastPull as { at: string; outcome: string; via: string | null; reason: string | null; detail: string | null; trigger: string } | null;
  const reads = s.reads as { hour: string; pointer: number; origin: number } | undefined;
  return (
    <article className={`host${stale ? " stale" : ""}${z.status === "degraded" ? " degraded" : ""}`}>
      <header>
        <strong>{host.region}</strong> <span className="muted" title={TOOLTIPS.puller}>· puller (the fleet pattern)</span>
        <span className={`chip health-${z.status ?? "unknown"}`}>{z.status ?? "—"}</span>
      </header>
      <dl className="kv">
        <div><dt title={TOOLTIPS.release}>exchange</dt><dd>{s.generation ? <>release #{s.generation} · pulled {ago(s.pulledAt ?? null)}{s.keyId ? <span title={TOOLTIPS.distributionKey}> · sealed to key {shortKey(s.keyId)}</span> : <span className="staged" title="Allowed on the dev target only; the SDK refuses plaintext anywhere else."> · plaintext (dev)</span>}</> : "nothing pulled yet"}</dd></div>
        <div><dt>last pull</dt><dd>{last ? <>{last.outcome}{last.via ? ` via ${last.via}` : ""}{last.reason ? <span className="refusal"> · {last.reason}</span> : ""} · {ago(last.at)} · {last.trigger}{last.detail ? <span className="muted"> · {last.detail}</span> : ""}</> : "—"}</dd></div>
        <div><dt>this hour</dt><dd>{reads ? `${reads.pointer} CDN read${reads.pointer === 1 ? "" : "s"} · ${reads.origin} API read${reads.origin === 1 ? "" : "s"}` : "—"}{s.edge?.pointerKnown ? <span className="muted"> · idle checks go to the pointer</span> : <span className="muted"> · no pointer known yet</span>}</dd></div>
        <div><dt>schedule</dt><dd>every {Math.round(Number(s.intervalSeconds ?? 300) / 60)} min{s.nextPullAt ? ` · next pull ${countdown(s.nextPullAt)} (backoff: ${s.unchangedStreak} unchanged in a row)` : " · the next tick pulls"}</dd></div>
        <div><dt title={TOOLTIPS.nudge}>nudges</dt><dd>{s.nudges ?? 0} · <span className="muted">a nudge reads the origin now</span></dd></div>
        <div><dt title={TOOLTIPS.distributionKey}>recipient</dt><dd>{s.recipientKeyId ? `the air-gapped host's key ${shortKey(s.recipientKeyId)}` : "no distribution key in the exchange (the air-gapped host is down)"}</dd></div>
        <div><dt>mirrors</dt><dd>{s.airgapMirroredAt ? `the air-gapped host's status, written ${ago(s.airgapMirroredAt)}` : "no air-gapped status document yet"}</dd></div>
        <div><dt>sdk</dt><dd>{host.sdk}</dd></div>
        <div><dt>container</dt><dd>{host.container.instanceId.slice(0, 15)} · {host.container.invocations} inv · {host.container.coldStart ? "cold" : "warm"}</dd></div>
      </dl>
      {z.reasons?.length ? <p className={z.status === "ok" ? "muted" : "problem fine"}>{z.reasons.join(", ")}</p> : null}
      <footer className="muted">written {ago(host.writtenAt)}</footer>
    </article>
  );
}

function AirgapCard({ host }: { host: HostStatus }) {
  const s = host.status ?? {};
  const z = host.healthz ?? {};
  const a = host.airgap;
  // The host writes every minute and the puller mirrors on its schedule: a document older than fifteen minutes is a torn-down host.
  const stale = Date.now() - Date.parse(host.writtenAt) > 15 * 60_000;
  const protection = String(s.storageProtection ?? "—");
  const lastApply = a?.applies?.length ? a.applies[a.applies.length - 1]! : null;
  return (
    <article className={`host${stale ? " stale" : ""}${z.status === "degraded" ? " degraded" : ""}`}>
      <header>
        <strong>{host.region}</strong> <span className="muted" title={TOOLTIPS.airgap}>· air-gapped host</span>
        <span className={`chip health-${z.status ?? "unknown"}`}>{z.status ?? a?.phase ?? "—"}</span>
      </header>
      <dl className="kv">
        <div><dt>route out</dt><dd><span className="chip protection-file_key">none</span> <span className="muted">· telemetry by export/import</span>{a?.probe ? <span className="muted"> · probe: {a.probe.curl.meaning} ({a.probe.curl.seconds}s); DNS {a.probe.dns.resolved ? "resolves" : "does not resolve"}</span> : null}</dd></div>
        <div><dt>release</dt><dd>{s.generation ? <>#{s.generation} · {effectiveApplyState(s) ?? "—"}{s.lastRefusal && !staleRefusal(s) ? <span className="refusal"> · refused: {s.lastRefusal}</span> : ""}</> : a?.phase === "awaiting_bundle" ? <span className="staged">awaiting a bundle sealed to its key{a.waitingFor?.newest ? ` (the exchange holds #${a.waitingFor.newest.generation}, ${a.waitingFor.newest.keyId ? `sealed to ${shortKey(a.waitingFor.newest.keyId)}` : "plaintext"})` : ""}</span> : "—"}</dd></div>
        <div><dt title={TOOLTIPS.distributionKey}>distribution key</dt><dd><span className={`chip ${a?.keyPublished ? "health-ok" : "health-degraded"}`}>key {shortKey(a?.keyId)}</span> <span className="muted">· born on the host; {a?.keyPublished ? "the public half is in the exchange" : "the public half is not in the exchange yet"}</span></dd></div>
        <div><dt title={TOOLTIPS.storage}>store key</dt><dd><span className={`chip protection-${protection}`}>{protection}</span>{protection === "file_key" ? <span className="muted"> · a 0600 file beside the store</span> : null}</dd></div>
        <div><dt>source</dt><dd>{s.source ?? "—"} <span className="muted">· sync offline · no Agent key on this host</span></dd></div>
        <div><dt>last apply</dt><dd>{lastApply ? <>#{lastApply.generation ?? "—"} {lastApply.outcome}{lastApply.reason ? <span className="refusal"> ({lastApply.reason})</span> : ""} · {ago(lastApply.at)} · from {lastApply.source === "vendored" ? "the vendored bundle" : "the exchange"}</> : "—"}</dd></div>
        <div><dt>renders</dt><dd>{a ? <>{a.renders.count} probe{a.renders.count === 1 ? "" : "s"}{a.renders.last ? ` · last ${a.renders.last.versionId} on ${a.renders.last.model}${a.renders.last.arm && a.renders.last.arm !== "none" ? ` · arm ${a.renders.last.arm}` : ""} ${ago(a.renders.lastAt)}` : ""} <span className="muted">· each observation filed as refused: no model here</span></> : "—"}</dd></div>
        <div><dt>export</dt><dd>{a?.export ? `${a.export.segments} segment${a.export.segments === 1 ? "" : "s"} ${ago(a.export.at)}${a.export.object ? " → the exchange" : " (nothing to carry)"}` : "no export yet"}</dd></div>
        <div><dt>spool</dt><dd>{s.spool?.depthSegments ?? 0} seg · {s.spool?.depthBytes ?? 0} B</dd></div>
        <div><dt>sdk</dt><dd>{host.sdk}</dd></div>
        <div><dt>instance</dt><dd>{host.ec2 ? `${host.ec2.instanceId} · ${host.ec2.availabilityZone}` : "—"} · sdk {host.container.instanceId.slice(0, 12)}</dd></div>
      </dl>
      {z.reasons?.length ? <p className={z.status === "ok" ? "muted" : "problem fine"}>{z.reasons.join(", ")}</p> : null}
      <footer className="muted">written {ago(host.writtenAt)}{host.mirroredAt ? ` · mirrored by the puller ${ago(host.mirroredAt)}` : ""}</footer>
    </article>
  );
}
