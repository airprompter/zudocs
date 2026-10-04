/**
 * The desk, signed in. This is Zudocs Support: the inbox is the product.
 * Saved records and deployment controls have dedicated pages. Extra evidence
 * opens in a modal side panel.
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
import { CodeDrawer } from "./components/CodeDrawer";
import { Database, type RecordReads } from "./components/Database";
import { SlideOut } from "./components/SlideOut";
import { SystemOverview } from "./components/SystemOverview";
import { RecordComparison } from "./components/RecordComparison";
import { ExperimentDemo } from "./components/ExperimentDemo";
import { Metrics } from "./components/Metrics";
import { Experiments } from "./components/Experiments";
import { Inbox } from "./components/Inbox";
import { Presenter, type CliOutput } from "./components/Presenter";
import { ReleaseJourney } from "./components/ReleaseJourney";
import { TicketView, type RouteAvailability } from "./components/TicketView";
import { mergeEvents } from "./format";
import { PAGE_LABEL, deskHref, newestHost, parseDeskRoute, releaseHostId, supportHostSnapshot, ticketParam, type DeskRoute } from "./route";
import { AIRGAP_START, CLIENT_RUN, DAEMON_START, ENQUEUE_CALL, LAMBDA_START, POLICY_LINE, RUN_STEP, TELEMETRY_DAEMON, type Snippet } from "./snippets";

export interface Notice { tone: "info" | "warn" | "error"; text: string }

function snippetsFor(route: DeskRoute): readonly Snippet[] {
  switch (route) {
    case "compare":
    case "metrics":
    case "database":
    case "experiments":
    case "architecture":
      return [LAMBDA_START, DAEMON_START, POLICY_LINE, TELEMETRY_DAEMON, AIRGAP_START];
    case "agent":
      return [RUN_STEP, LAMBDA_START, CLIENT_RUN];
    case "daemon":
      return [RUN_STEP, DAEMON_START, POLICY_LINE, TELEMETRY_DAEMON, ENQUEUE_CALL];
    case "operate":
      return [LAMBDA_START, DAEMON_START, POLICY_LINE, TELEMETRY_DAEMON, AIRGAP_START];
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
  const [runsUnavailable, setRunsUnavailable] = useState(false);
  const [runsTicketId, setRunsTicketId] = useState<string | null>(null);
  const [runsReadAt, setRunsReadAt] = useState<string | null>(null);
  const runsRequest = useRef(0);
  const [reads, setReads] = useState<RecordReads>({ tickets: { at: null, error: false }, hosts: { at: null, error: false }, approvals: { at: null, error: false }, events: { at: null, error: false } });
  const markRead = useCallback((key: keyof RecordReads, error = false) => setReads((current) => ({ ...current, [key]: { at: error ? current[key].at : new Date().toISOString(), error } })), []);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [arms, setArms] = useState<Arms | null>(null);

  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sheet, setSheet] = useState(false);
  const [journeyOpen, setJourneyOpen] = useState(false);
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
    setJourneyOpen(false);
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
      markRead("tickets");
      setPickedId((current) => current ?? next[0]?.ticketId ?? null);
    } catch (error) { markRead("tickets", true); failed(error); } finally { setInboxReady(true); }
  }, [api, failed, markRead]);
  const loadRuns = useCallback(async (ticketId: string) => {
    const request = ++runsRequest.current;
    try {
      const { runs: next } = await api.ticket(ticketId);
      if (!Array.isArray(next) || request !== runsRequest.current) return;
      setRuns(next);
      setRunsTicketId(ticketId);
      setRunsReadAt(new Date().toISOString());
      setRunsUnavailable(false);
      setMissingId((current) => (current === ticketId ? null : current));
    } catch (error) {
      if (request !== runsRequest.current) return;
      if (error instanceof ApiError && error.error === "no_such_ticket") {
        setRuns([]);
        setMissingId(ticketId);
        setRunsUnavailable(true);
      } else { setRunsUnavailable(true); failed(error); }
    }
  }, [api, failed, markRead]);
  const loadState = useCallback(async () => {
    if (polling.current.state) return;
    polling.current.state = true;
    try {
      const next = await api.state();
      if (typeof next?.host?.hostId === "string" && Array.isArray(next.hosts)) { setState(next); markRead("hosts"); }
    } catch { markRead("hosts", true); } finally { polling.current.state = false; }
  }, [api, failed, markRead]);
  const loadEvents = useCallback(async () => {
    if (polling.current.events) return;
    polling.current.events = true;
    try {
      const { events: fresh } = await api.events(lastEventAt.current);
      if (!Array.isArray(fresh)) return;
      markRead("events");
      if (fresh.length === 0) return;
      lastEventAt.current = fresh[fresh.length - 1]!.at;
      setEvents((current) => mergeEvents(current, fresh));
    } catch { markRead("events", true); } finally { polling.current.events = false; }
  }, [api, markRead]);
  const loadApprovals = useCallback(async () => {
    if (polling.current.approvals) return;
    polling.current.approvals = true;
    try {
      const body = await api.approvals();
      if (Array.isArray(body.approvals)) { setApprovals(body.approvals); markRead("approvals"); }
    } catch { markRead("approvals", true); } finally { polling.current.approvals = false; }
  }, [api, markRead]);
  const loadArms = useCallback(async () => {
    if (polling.current.arms) return;
    polling.current.arms = true;
    try {
      const next = await api.arms(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (Array.isArray(next?.arms) && Array.isArray(next.ramps) && Array.isArray(next.stickiness)) setArms(next);
    } catch { /* next poll */ } finally { polling.current.arms = false; }
  }, [api, markRead]);

  useEffect(() => {
    const sync = () => { setLoc(location.pathname + location.search); setJourneyOpen(false); setSheet(false); };
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
    const newest = [...events].reverse().find((e) => e.kind === "ticket_run");
    const key = newest ? (newest.id ?? `${newest.at}|${newest.host}`) : null;
    if (key && key !== seenForeignRun.current) {
      seenForeignRun.current = key;
      if (selectedId) void loadRuns(selectedId);
      void loadTickets();
      void loadArms();
    }
  }, [events, selectedId, loadRuns, loadTickets, loadArms, state]);

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

  const run = (ticketId: string, kind: "run" | "escalate", provider?: DirectProvider) => act(kind, async () => {
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
    await Promise.all([loadState(), loadEvents(), action === "seed" || action === "reset" ? loadTickets() : Promise.resolve(), loadArms(), action === "reset" ? loadApprovals() : Promise.resolve()]);
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
  const ticketRuns = runs.filter((run) => run.ticketId === selectedId);
  const inboxRuns = ticketRuns.filter((run) => run.host === (route === "daemon" ? daemonHostId : lambdaHostId));
  const runHost = newestHost(inboxRuns);
  const supportHost = supportHostSnapshot(state, releaseHostId(route, runHost, lambdaHostId, daemonHostId));
  const selected = tickets.find((t) => t.ticketId === selectedId) ?? null;
  const missing = missingId !== null && missingId === selectedId;
  const powerNote = daemonHost?.powerView && daemonHost.powerView.phase !== "awake" ? daemonHost.powerView.label : null;
  const inInbox = route === "agent" || route === "daemon";
  const inDatabase = route === "database" || route === "compare";
  const inSystem = !inInbox && !inDatabase;
  const refreshRecords = () => { void loadTickets(); void loadState(); void loadEvents(); void loadApprovals(); if (selectedId) void loadRuns(selectedId); };
  return (
    <div className={`desk route-${route}`}>
      <header className="top">
        <span className="brand">Zu<span>docs</span> <em>support</em></span>
        <nav className="desk-nav" aria-label="Pages">
          {(["agent", "database", "architecture"] as const).map((page) => <a key={page} href={deskHref(page, selectedId)} aria-current={(page === "agent" ? inInbox : page === "architecture" ? inSystem : (page === "database" ? inDatabase : route === page)) ? "page" : undefined} onClick={(event) => follow(event, page)}>{PAGE_LABEL[page]}</a>)}
        </nav>
        <div className="who"><button type="button" className="link" onClick={onSignOut}>Sign out</button></div>
      </header>
      {inInbox ? <>
        <nav className="inbox-mode" aria-label="Reply host"><span className="fine muted">Reply host</span>{(["agent", "daemon"] as const).map((page) => <a key={page} href={deskHref(page, selectedId)} aria-current={route === page ? "page" : undefined} onClick={(event) => follow(event, page)}>{page === "agent" ? "US desk" : "Europe workers"}</a>)}</nav>
        <AgentLine host={supportHost} events={events} label={route === "daemon" ? "Europe support agent" : "Support agent"} expanded={journeyOpen} onJourney={() => setJourneyOpen((open) => !open)} />
      </> : null}
      {journeyOpen && supportHost ? <SlideOut title="AirPrompter status & settings" onClose={() => setJourneyOpen(false)}><ReleaseJourney host={supportHost} approvals={approvals} events={events} runs={inboxRuns} ticketId={selectedId} /></SlideOut> : null}
      {notice ? <div className={`notice notice-${notice.tone}`} role="status">{notice.text}<button type="button" className="link" onClick={() => setNotice(null)}>dismiss</button></div> : null}
      <div className="columns">
        {route === "agent" || route === "daemon" ? (
          <>
            <Inbox tickets={tickets} selectedId={selectedId} onSelect={selectTicket} />
            <main className="centre">
              <div className="reading">
                {missing ? <p className="problem">This ticket was not found. Select a ticket from the inbox.</p> : selected ? (
                  <TicketView key={`${route}-${selected.ticketId}`}
                    ticket={selected}
                    runs={inboxRuns}
                    busy={busy}
                    frozen={state?.frozen ?? null}
                    routes={routes}
                    hosts={supportHost ? [...(state?.hosts ?? []).filter((host) => host.hostId !== supportHost.hostId), supportHost] : state?.hosts ?? []}
                    events={events}
                    enqueue={route === "daemon" ? {
                      label: daemonHostId ? `Enqueue ${selected.ticketId}` : "Enqueue",
                      disabled: daemonHostId === null,
                      note: daemonHostId === null ? "no daemon host has reported" : powerNote,
                      onEnqueue: () => { if (daemonHostId) presenter("enqueue", { ticketId: selected.ticketId, host: daemonHostId }); },
                    } : null}
                    emptyNote={!state ? "Reading the selected host…" : runsUnavailable ? "Saved replies could not be loaded. Refresh to try again." : runsTicketId !== selectedId ? "Reading saved replies…" : route === "daemon" ? "No saved reply from Europe for this ticket. Enqueue it to request one." : "No reply yet — Draft reply writes one from the docs."}
                    onBehind={openBehind}
                    onRun={(provider) => run(selected.ticketId, "run", provider)}
                    onEscalate={() => run(selected.ticketId, "escalate")}
                    onFeedback={feedback}
                  />
                ) : inboxReady ? <div className="empty">No tickets yet — re-seed the inbox from System controls.</div> : <div className="empty">Reading the inbox…</div>}
              </div>
            </main>
          </>
        ) : null}
        {route === "compare" ? <main className="centre"><RecordComparison api={api} runs={ticketRuns} ticketId={selectedId} boardUrl={config.airprompterBoardUrl} tickets={tickets} onSelect={selectTicket} ready={runsTicketId === selectedId && selectedId !== null} /></main> : null}
        {route === "database" ? <main className="centre"><Database tickets={tickets} runs={ticketRuns} selectedId={selectedId} onSelect={selectTicket} state={state} approvals={approvals} events={events} reads={reads} runsReady={runsTicketId === selectedId && selectedId !== null} runsReadAt={runsTicketId === selectedId ? runsReadAt : null} runsUnavailable={runsUnavailable} onRefresh={refreshRecords} /></main> : null}
        {inSystem ? <main className="centre"><div className="page-content system">
          <header className="page-heading"><div><p className="eyebrow">AirPrompter integration</p><h1>System</h1><p className="muted">Deployment status, approvals and controls.</p></div></header>
          <nav className="section-nav" aria-label="System pages">{(["architecture", "experiments", "metrics", "operate"] as const).map((page) => <a key={page} href={deskHref(page, selectedId)} aria-current={route === page ? "page" : undefined} onClick={(event) => follow(event, page)}>{page === "architecture" ? "Overview" : PAGE_LABEL[page]}</a>)}</nav>
          {route === "architecture" ? <SystemOverview state={state} approvals={approvals} busy={busy} onApprove={approve} onBehind={openBehind} reads={reads} /> : null}
          {route === "operate" ? <Presenter state={state} busy={busy} onAction={presenter} environment={config.environment} agentId={config.agentId} cliOutput={newestCli(events)} /> : null}
          {route === "experiments" ? <><ExperimentDemo api={api} state={state} busy={busy} onAction={presenter} boardUrl={config.airprompterBoardUrl} /><Experiments arms={arms} /></> : null}
          {route === "metrics" ? <Metrics events={events} state={state} arms={arms} busy={busy} onAction={presenter} boardUrl={config.airprompterBoardUrl} ticketId={selectedId} /> : null}
        </div></main> : null}
        {sheet ? <CodeDrawer snippets={snippetsFor(route)} focus={sheetFocus} onClose={() => { setSheet(false); setSheetFocus(null); }} /> : null}
      </div>
    </div>
  );
}
