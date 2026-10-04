/**
 * Compact host overview; each host's implementation details open in a side panel.
 * @example
 * <SystemOverview state={state} onBehind={openCode} />
 */
import { useState } from "react";
import type { Api, State } from "../api";
import { ago, effectiveApplyState } from "../format";
import { HostDetail } from "./HostCards";
import { SlideOut } from "./SlideOut";
import { RolloutStatus } from "./RolloutStatus";
import { Fold } from "./Fold";
import type { RecordReads } from "./Database";
import { ReleaseBar } from "./ReleaseBar";

const HOST_ORDER: Record<string, number> = { lambda: 0, daemon: 1, puller: 2, airgapped: 3 };

export function SystemOverview({ state, onBehind, reads, api, boardUrl }: { state: State | null; onBehind: (id: string) => void; reads: RecordReads; api: Api; boardUrl?: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const hosts = [...(state?.hosts ?? [])].sort((a, b) => (HOST_ORDER[a.kind] ?? 4) - (HOST_ORDER[b.kind] ?? 4) || a.hostId.localeCompare(b.hostId));
  const host = hosts.find((row) => row.hostId === picked);
  return <>
    {reads.hosts.error ? <p className="problem">Host reports could not be refreshed. Previously loaded reports remain visible.</p> : null}
    <RolloutStatus api={api} state={state} boardUrl={boardUrl} />
    <ReleaseBar state={state} />
    <Fold title="Host details"><section className="record-list" aria-label="Deployment hosts">
      <div className="record-list-head"><h2>Hosts</h2><span className="fine muted">{hosts.length} recorded</span></div>
      {state ? hosts.map((row) => <button type="button" key={row.hostId} className="record-row" onClick={() => setPicked(row.hostId)}>
        <span><strong>{row.region} · {row.kind === "lambda" ? "Support desk" : row.kind === "daemon" ? "Europe workers" : row.kind === "puller" ? "Release distribution" : "Offline host"}</strong><small>{row.kind === "puller" ? "Exchange" : "Release"} #{row.status?.generation ?? "—"}{row.kind !== "puller" ? ` · ${effectiveApplyState(row.status ?? {}) ?? "unreported"}` : ""}{row.status?.stagedGeneration ? ` · #${row.status?.stagedGeneration} staged` : ""} · report {ago(row.writtenAt)}</small></span>
        <span className="record-open">{row.powerView?.phase !== undefined && row.powerView.phase !== "awake" ? row.powerView.label : Date.now() - Date.parse(row.writtenAt) > (row.kind === "lambda" ? 2 * 60 * 60_000 : row.kind === "daemon" ? 10 * 60_000 : 15 * 60_000) ? "Old report" : row.healthz.status ?? "unreported"} →</span>
      </button>) : <p className="empty muted">Reading host reports…</p>}
    </section></Fold>
    {state ? <Fold title="Integration identity"><dl className="integration-settings"><div><dt>Environment</dt><dd>{state.airprompter.environment}</dd></div><div><dt>AirPrompter agent</dt><dd>{state.airprompter.agentId}</dd></div><div><dt>SDK</dt><dd>{state.host.sdk}</dd></div></dl></Fold> : null}

    {host ? <SlideOut title={`${host.region} · ${host.kind}`} onClose={() => setPicked(null)}><HostDetail host={host} onBehind={onBehind} /></SlideOut> : null}
  </>;
}
