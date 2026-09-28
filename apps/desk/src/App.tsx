/**
 * The desk, signed in. This is Zudocs Support: the inbox is the product.
 * Hosts, Europe and Operator are quiet links. A quiet link on a fact opens
 * the source that produced it.
 *
 * @example
 * ```tsx
 * <App api={createApi(config.apiUrl, tokenOf)} config={config} who="seth@zudocs.com" onSignOut={signOut} />
 * ```
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type AnyRun, type Api, type Approval, type Arms, type DirectProvider, type Route, type State, type Ticket, type TimelineEvent } from "./api";
import type { DeskConfig } from "./config";
import { AgentLine } from "./components/AgentLine";
import { Approvals } from "./components/Approvals";
import { CodeDrawer } from "./components/CodeDrawer";
import { DaemonSummary } from "./components/DaemonSummary";
import { Fleet } from "./components/Fleet";
import { HostCards } from "./components/HostCards";
import { Experiments } from "./components/Experiments";
import { Fold } from "./components/Fold";
import { Inbox } from "./components/Inbox";
import { Presenter, type CliOutput } from "./components/Presenter";
import { ReleaseBar } from "./components/ReleaseBar";
import { TicketView, routeRefusal, type RouteAvailability } from "./components/TicketView";
import { Timeline } from "./components/Timeline";
import { ROUTES, abTitle, mergeEvents, releaseSummary } from "./format";
import { PAGE_LABEL, deskHref, mismatchRoute, newestHost, parseDeskRoute, ticketParam, type DeskRoute } from "./route";
import { AIRGAP_START, CLIENT_RUN, DAEMON_CONNECT, DAEMON_GUARD, DAEMON_START, ENQUEUE_CALL, LAMBDA_START, POLICY_LINE, RUN_STEP, type Snippet } from "./snippets";

export interface Notice { tone: "info" | "warn" | "error"; text: string }

function snippetsFor(route: DeskRoute): readonly Snippet[] {
  switch (route) {
    case "architecture":
      return [LAMBDA_START, DAEMON_CONNECT, DAEMON_START, DAEMON_GUARD, POLICY_LINE, AIRGAP_START];
    case "agent":
      return [RUN_STEP, LAMBDA_START, CLIENT_RUN];
    case "daemon":
      return [DAEMON_CONNECT, DAEMON_START, DAEMON_GUARD, POLICY_LINE, ENQUEUE_CALL];
    case "operate":
      return [LAMBDA_START, DAEMON_CONNECT, DAEMON_START, DAEMON_GUARD, POLICY_LINE, AIRGAP_START];
    default: {
      const unexpected: never = route;
      return unexpected;
    }
  }
}

/** The newest host-CLI answer on the timeline (the job writes it there), for the presenter panel. */
function newestCli(events: TimelineEvent[]): CliOutput | null {
  const row = [...events].reverse().find((e) => e.kind === "host_cli");
  if (!row) return null;
  return { command: String(row.command ?? ""), summary: String(row.summary ?? ""), document: row.document ?? null, stdout: String(row.stdout ?? ""), status: String(row.status ?? ""), at: row.at };
}

function splitLoc(loc: string): { pathname: string; search: string } {
  const q = loc.indexOf("?");
  return q < 0 ? { pathname: loc, search: "" } : { pathname: loc.slice(0, q), search: loc.slice(q) };
}

export function App({ api, config, who, onSignOut }: { api: Api; config: DeskConfig; who: string; onSignOut: () => void }) {
  const [loc, setLoc] = useState(() => location.pathname + location.search);
  const { pathname, search } = splitLoc(loc);
  const route = parseDeskRoute(pathname);
  const urlTicket = ticketParam(search);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [inboxReady, setInboxReady] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId = urlTicket ?? pickedId;
  const [runs, setRuns] = useState<AnyRun[]>([]);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [arms, setArms] = useState<Arms | null>(null);

  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sheet, setSheet] = useState(false);
  const [sheetFocus, setSheetFocus] = useState<string | null>(null);
  const openBehind = (id: string) => {
    setSheetFocus(id);
    setSheet(true);
  };
  const lastEventAt = useRef<string | null>(null);
  const polling = useRef<{ events: boolean; approvals: boolean; state: boolean; arms: boolean }>({ events: false, approvals: false, state: false, arms: false });

  const say = useCallback((tone: Notice["tone"], text: string) => setNotice({ tone, text }), []);
  const failed = useCallback((error: unknown) => {
    if (error instanceof ApiError) say(error.status === 429 ? "warn" : "error", `${error.error}: ${error.message}`);
    else say("error", (error as Error).message);
  }, [say]);

  const remember = useCallback((url: string, mode: "push" | "replace") => {
    if (location.pathname + location.search === url) return;
    if (mode === "replace") history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    setLoc(location.pathname + location.search);
  }, []);

  const go = useCallback((next: DeskRoute, ticket: string | null, mode: "push" | "replace" = "push") => {
    setSheet(false);
    setSheetFocus(null);
    remember(deskHref(next, ticket), mode);
  }, [remember]);

  const follow = (event: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }, next: DeskRoute) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    go(next, selectedId);
  };

  const loadTickets = useCallback(async () => {
    try {
      const { tickets: next } = await api.tickets();
      if (!Array.isArray(next)) return;
      setTickets(next);
      setPickedId((current) => current ?? next[0]?.ticketId ?? null);
    } catch (error) { failed(error); } finally { setInboxReady(true); }
  }, [api, failed]);
  const loadRuns = useCallback(async (ticketId: string) => {
    try {
      const { runs: next } = await api.ticket(ticketId);
      if (!Array.isArray(next)) return;
      setRuns(next);
      setMissingId((current) => (current === ticketId ? null : current));
    } catch (error) {
      if (error instanceof ApiError && error.error === "no_such_ticket") {
        setRuns([]);
        setMissingId(ticketId);
      } else failed(error);
    }
  }, [api, failed]);
  const loadState = useCallback(async () => {
    if (polling.current.state) return;
    polling.current.state = true;
    try {
      const next = await api.state();
      if (typeof next?.host?.hostId === "string" && Array.isArray(next.hosts)) setState(next);
    } catch { /* the next poll tries again; a missing fleet row is not a support-desk banner */ } finally { polling.current.state = false; }
  }, [api, failed]);
  const loadEvents = useCallback(async () => {
    if (polling.current.events) return;
    polling.current.events = true;
    try {
      const { events: fresh } = await api.events(lastEventAt.current);
      if (!Array.isArray(fresh) || fresh.length === 0) return;
      lastEventAt.current = fresh[fresh.length - 1]!.at;
      setEvents((current) => mergeEvents(current, fresh));
    } catch { /* the next poll tries again; a timeline gap is not worth a banner */ } finally { polling.current.events = false; }
  }, [api]);
  const loadApprovals = useCallback(async () => {
    if (polling.current.approvals) return;
    polling.current.approvals = true;
    try {
      const body = await api.approvals();
      if (Array.isArray(body.approvals)) setApprovals(body.approvals);
    } catch { /* next poll */ } finally { polling.current.approvals = false; }
  }, [api]);
  const loadArms = useCallback(async () => {
    if (polling.current.arms) return;
    polling.current.arms = true;
    try {
      const next = await api.arms();
      if (Array.isArray(next?.arms) && Array.isArray(next.ramps) && Array.isArray(next.stickiness)) setArms(next);
    } catch { /* next poll */ } finally { polling.current.arms = false; }
  }, [api]);

  useEffect(() => {
    const sync = () => setLoc(location.pathname + location.search);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => { void loadTickets(); void loadState(); void loadEvents(); void loadApprovals(); void loadArms(); }, [loadTickets, loadState, loadEvents, loadApprovals, loadArms]);
  useEffect(() => {
    const s = setInterval(() => void loadState(), 10_000);
    const e = setInterval(() => { void loadEvents(); void loadApprovals(); }, 5_000);
    const a = setInterval(() => void loadArms(), 20_000);
    return () => { clearInterval(s); clearInterval(e); clearInterval(a); };
  }, [loadState, loadEvents, loadApprovals, loadArms]);
  useEffect(() => {
    if (!urlTicket && pickedId) remember(deskHref(route, pickedId), "replace");
  }, [urlTicket, pickedId, route, remember]);
  useEffect(() => { if (selectedId) void loadRuns(selectedId); else setRuns([]); }, [selectedId, loadRuns]);
  const seenForeignRun = useRef<string | null>(null);
  useEffect(() => {
    const newest = [...events].reverse().find((e) => e.kind === "ticket_run" && state && e.host !== state.host.hostId);
    const key = newest ? (newest.id ?? `${newest.at}|${newest.host}`) : null;
    if (key && key !== seenForeignRun.current) {
      seenForeignRun.current = key;
      if (selectedId) void loadRuns(selectedId);
      void loadTickets();
    }
  }, [events, selectedId, loadRuns, loadTickets, state]);

  const act = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try { await fn(); } catch (error) { failed(error); } finally { setBusy(null); }
  }, [failed]);

  const routes = useMemo((): Record<Route, RouteAvailability> => ({
    bedrock: { configured: true, model: null },
    openai: { configured: state?.providers?.openai.configured ?? false, model: state?.providers?.openai.model ?? null, door: state?.providers?.openai.door, used: state?.providers?.openai.used, cap: state?.providers?.openai.cap },
    anthropic: { configured: state?.providers?.anthropic.configured ?? false, model: state?.providers?.anthropic.model ?? null, door: state?.providers?.anthropic.door, used: state?.providers?.anthropic.used, cap: state?.providers?.anthropic.cap },
    airprompter: { configured: (state?.features?.hosted ?? false) && !!state?.hosted, model: null },
  }), [state]);

  const compareAll = (ticketId: string) => act("compare", async () => {
    let answered = 0;
    for (const name of ROUTES) {
      if (routeRefusal(name, routes[name]) !== null) continue;
      if (name === "airprompter") {
        const { run } = await api.hostedRun(ticketId);
        setRuns((current) => [run, ...current]);
      } else {
        const { run } = await api.runTicket(ticketId, name === "bedrock" ? undefined : name);
        setRuns((current) => [run, ...current]);
      }
      answered += 1;
    }
    say("info", `${answered} routes answered — the compare table is above the runs`);
    await Promise.all([loadTickets(), loadState(), loadEvents(), loadArms()]);
  });

  const run = (ticketId: string, kind: "run" | "escalate" | "hosted", provider?: DirectProvider) => act(kind, async () => {
    if (kind === "hosted") {
      const { run: hosted } = await api.hostedRun(ticketId);
      setRuns((current) => [hosted, ...current]);
      say(hosted.ok ? "info" : "warn", hosted.ok ? `hosted staging answered: ${hosted.stream.deltas.length} deltas, arm ${hosted.stream.result?.arm ?? "—"}, ${hosted.stream.result?.priceMicros ?? "—"} µ$` : `hosted staging: ${hosted.gaps[0] ?? "the route refused"}`);
      await loadEvents();
      return;
    }
    const { run: record } = kind === "run" ? await api.runTicket(ticketId, provider) : await api.escalateTicket(ticketId);
    setRuns((current) => [record, ...current]);
    if (!record.ok) say("warn", "the model did not answer every step — the record shows what the host observed");
    await Promise.all([loadTickets(), loadState(), loadEvents(), loadArms()]);
  });
  const feedback = (runId: string, step: string, signals: Record<string, unknown>) => act("feedback", async () => {
    const { filed, message } = await api.feedback(runId, step, signals);
    say(filed ? "info" : "warn", message);
    if (selectedId) await loadRuns(selectedId);
    await loadEvents();
  });
  const presenter = (action: string, body?: Record<string, unknown>) => act(action, async () => {
    const result = await api.presenter(action, body);
    say("info", typeof result.message === "string" ? result.message : `${action}: done`);
    await Promise.all([loadState(), loadEvents(), action === "seed" || action === "reset" ? loadTickets() : Promise.resolve(), action === "reset" || action === "replay" ? loadArms() : Promise.resolve(), action === "reset" ? loadApprovals() : Promise.resolve()]);
    if (action === "seed" || action === "reset") { setRuns([]); if (action === "reset") { setEvents([]); lastEventAt.current = null; } }
  });
  const approve = (approvalId: string) => act("approve", async () => {
    try {
      const { message, already } = await api.approve(approvalId);
      say(already ? "warn" : "info", message);
    } finally {
      await Promise.all([loadApprovals(), loadEvents()]);
    }
  });

  const selectTicket = (id: string) => {
    setPickedId(id);
    setMissingId(null);
    remember(deskHref(route, id), "push");
  };

  const lambdaHostId = state?.host?.hostId ?? null;
  const daemonHost = state?.hosts?.find((h) => h.kind === "daemon") ?? null;
  const daemonHostId = daemonHost?.hostId ?? null;
  const runHost = newestHost(runs);
  const other = (route === "agent" || route === "daemon") && runHost ? mismatchRoute(route, runHost, lambdaHostId, daemonHostId) : null;
  const selected = tickets.find((t) => t.ticketId === selectedId) ?? null;
  const missing = missingId !== null && missingId === selectedId;
  const powerNote = daemonHost?.powerView && daemonHost.powerView.phase !== "awake" ? daemonHost.powerView.label : null;
  const fleet = state ? releaseSummary(state.hosts) : null;
  const updatedAt = [...events].reverse().find((event) => event.kind === "release_changed" || event.kind === "release_activated")?.at ?? null;
  const desk = { generation: fleet?.generation ?? null, staged: fleet?.staged?.generation ?? null, updatedAt };

  return (
    <div className={`desk route-${route}${sheet ? " sheet-open" : ""}`}>
      <header className="top">
        <a className="brand" href={deskHref("agent", selectedId)} onClick={(event) => follow(event, "agent")}>Zu<span>docs</span> <em>support</em></a>
        <nav className="desk-nav" aria-label="Pages">
          <a href={deskHref("agent", selectedId)} aria-current={route === "agent" ? "page" : undefined} onClick={(event) => follow(event, "agent")}>Inbox</a>
        </nav>
        <div className="who">
          <a className="link quiet" href={deskHref("daemon", selectedId)} aria-current={route === "daemon" ? "page" : undefined} onClick={(event) => follow(event, "daemon")}>{PAGE_LABEL.daemon}</a>
          <a className="link quiet" href={deskHref("architecture", selectedId)} aria-current={route === "architecture" ? "page" : undefined} onClick={(event) => follow(event, "architecture")}>{PAGE_LABEL.architecture}</a>
          <a className="link quiet" href={deskHref("operate", selectedId)} aria-current={route === "operate" ? "page" : undefined} onClick={(event) => follow(event, "operate")}>{PAGE_LABEL.operate}</a>
          <span className="muted">{who}</span>
          <button type="button" className="link" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <AgentLine state={state} events={events} />
      {notice ? <div className={`notice notice-${notice.tone}`} role="status">{notice.text}<button type="button" className="link" onClick={() => setNotice(null)}>dismiss</button></div> : null}
      <div className="columns">
        {route === "architecture" ? (
          <main className="centre">
            {state?.hosts?.length ? <HostCards state={state} onBehind={openBehind} /> : <Fleet onBehind={openBehind} note="no host has written its status yet" />}
          </main>
        ) : null}
        {route === "agent" || route === "daemon" ? (
          <>
            <Inbox tickets={tickets} selectedId={selectedId} onSelect={selectTicket} />
            <main className="centre">
              <div className="reading">
                {route === "daemon" ? (
                  <>
                    <Fold title={approvals.some((a) => a.decision === "pending") ? "Approvals · waiting" : "Approvals"}>
                      <Approvals approvals={approvals} busy={busy} onApprove={approve} />
                    </Fold>
                    <Fold title="Europe host">
                      <DaemonSummary host={daemonHost} onBehind={openBehind} />
                    </Fold>
                  </>
                ) : null}
                {missing ? <p className="problem">no_such_ticket</p> : selected ? (
                  <TicketView
                    ticket={selected}
                    runs={runs}
                    busy={busy}
                    frozen={state?.frozen ?? null}
                    hosted={state?.features?.hosted ? state.hosted ?? null : null}
                    routes={routes}
                    desk={desk}
                    elsewhere={other ? { href: deskHref(other, selected.ticketId), label: other === "daemon" ? "This reply was written on the Europe desk" : "This reply was written in the inbox", onClick: (event) => follow(event, other) } : null}
                    enqueue={route === "daemon" ? {
                      label: daemonHostId ? `Enqueue ${selected.ticketId}` : "Enqueue",
                      disabled: daemonHostId === null,
                      note: daemonHostId === null ? "no daemon host has reported" : powerNote,
                      onEnqueue: () => { if (daemonHostId) presenter("enqueue", { ticketId: selected.ticketId, host: daemonHostId }); },
                    } : null}
                    emptyNote="No reply yet — Draft reply writes one from the docs."
                    onBehind={openBehind}
                    onRun={(provider) => run(selected.ticketId, "run", provider)}
                    onEscalate={() => run(selected.ticketId, "escalate")}
                    onHosted={() => run(selected.ticketId, "hosted")}
                    onCompareAll={() => compareAll(selected.ticketId)}
                    onFeedback={feedback}
                  />
                ) : inboxReady ? <div className="empty">No tickets yet — re-seed the inbox from Operator controls.</div> : <div className="empty">Reading the inbox…</div>}
                <Fold title={abTitle(arms?.ramps, (arms?.arms ?? []).some((arm) => arm.arm !== "none"))}>
                  <Experiments arms={arms} />
                </Fold>
              </div>
            </main>
          </>
        ) : null}
        {route === "operate" ? (
          <main className="centre">
            <div className="operate">
              <ReleaseBar state={state} />
              <Presenter state={state} busy={busy} selectedTicketId={selectedId} onAction={presenter} environment={config.environment} agentId={config.agentId} cliOutput={newestCli(events)} />
              <HostCards state={state} onBehind={openBehind} />
              <Timeline events={events} />
            </div>
          </main>
        ) : null}
        {sheet ? <CodeDrawer snippets={snippetsFor(route)} focus={sheetFocus} onClose={() => { setSheet(false); setSheetFocus(null); }} /> : null}
      </div>
    </div>
  );
}
