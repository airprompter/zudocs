/**
 * The desk, signed in: the release bar across the top, the inbox on the left, the ticket and its run panel in
 * the middle, the fleet (host cards), the approvals, the presenter panel and the timeline on the right. State polls
 * the API — `/state` every 10 s, `/events` and `/approvals` every 5 s — because an on_invoke Lambda cannot push;
 * one poll of each kind is in flight at a time and timeline rows are merged by id, so a row is never shown twice.
 * Everything shown is the API's record; the app formats, it never computes a result of its own.
 *
 * @example
 * ```tsx
 * <App api={createApi(config.apiUrl, tokenOf)} config={config} who="seth@zudocs.com" onSignOut={signOut} />
 * ```
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Approval, type Run, type State, type Ticket, type TimelineEvent } from "./api";
import type { DeskConfig } from "./config";
import { Approvals } from "./components/Approvals";
import { HostCards } from "./components/HostCards";
import { Inbox } from "./components/Inbox";
import { Presenter } from "./components/Presenter";
import { ReleaseBar } from "./components/ReleaseBar";
import { TicketView } from "./components/TicketView";
import { Timeline } from "./components/Timeline";
import { mergeEvents } from "./format";

export interface Notice { tone: "info" | "warn" | "error"; text: string }

export function App({ api, config, who, onSignOut }: { api: Api; config: DeskConfig; who: string; onSignOut: () => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const lastEventAt = useRef<string | null>(null);
  const polling = useRef<{ events: boolean; approvals: boolean; state: boolean }>({ events: false, approvals: false, state: false });

  const say = useCallback((tone: Notice["tone"], text: string) => setNotice({ tone, text }), []);
  const failed = useCallback((error: unknown) => {
    if (error instanceof ApiError) say(error.status === 429 ? "warn" : "error", `${error.error}: ${error.message}`);
    else say("error", (error as Error).message);
  }, [say]);

  const loadTickets = useCallback(async () => {
    try {
      const { tickets } = await api.tickets();
      setTickets(tickets);
      setSelectedId((current) => current ?? tickets[0]?.ticketId ?? null);
    } catch (error) { failed(error); }
  }, [api, failed]);
  const loadRuns = useCallback(async (ticketId: string) => {
    try {
      const { runs } = await api.ticket(ticketId);
      setRuns(runs);
    } catch (error) { failed(error); }
  }, [api, failed]);
  const loadState = useCallback(async () => {
    if (polling.current.state) return;
    polling.current.state = true;
    try { setState(await api.state()); } catch (error) { failed(error); } finally { polling.current.state = false; }
  }, [api, failed]);
  const loadEvents = useCallback(async () => {
    // One poll in flight: the first load and the first interval tick both asked with no `since` and the timeline
    // showed every row twice; now the second waits, and the merge keys on the row id besides.
    if (polling.current.events) return;
    polling.current.events = true;
    try {
      const { events: fresh } = await api.events(lastEventAt.current);
      if (fresh.length === 0) return;
      lastEventAt.current = fresh[fresh.length - 1]!.at;
      setEvents((current) => mergeEvents(current, fresh));
    } catch { /* the next poll tries again; a timeline gap is not worth a banner */ } finally { polling.current.events = false; }
  }, [api]);
  const loadApprovals = useCallback(async () => {
    if (polling.current.approvals) return;
    polling.current.approvals = true;
    try { setApprovals((await api.approvals()).approvals); } catch { /* next poll */ } finally { polling.current.approvals = false; }
  }, [api]);

  useEffect(() => { void loadTickets(); void loadState(); void loadEvents(); void loadApprovals(); }, [loadTickets, loadState, loadEvents, loadApprovals]);
  useEffect(() => {
    const s = setInterval(() => void loadState(), 10_000);
    const e = setInterval(() => { void loadEvents(); void loadApprovals(); }, 5_000);
    return () => { clearInterval(s); clearInterval(e); };
  }, [loadState, loadEvents, loadApprovals]);
  useEffect(() => { if (selectedId) void loadRuns(selectedId); else setRuns([]); }, [selectedId, loadRuns]);
  // A run on another host lands in the ticket's list without a click: re-read the selected ticket's runs on each eu-west run event.
  const seenRuns = useRef(0);
  useEffect(() => {
    const foreign = events.filter((e) => e.kind === "ticket_run" && e.host !== state?.host.hostId).length;
    if (foreign !== seenRuns.current) {
      seenRuns.current = foreign;
      if (selectedId) void loadRuns(selectedId);
      void loadTickets();
    }
  }, [events, selectedId, loadRuns, loadTickets, state?.host.hostId]);

  const act = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try { await fn(); } catch (error) { failed(error); } finally { setBusy(null); }
  }, [failed]);

  const run = (ticketId: string, kind: "run" | "escalate") => act(kind, async () => {
    const { run } = kind === "run" ? await api.runTicket(ticketId) : await api.escalateTicket(ticketId);
    setRuns((current) => [run, ...current]);
    if (!run.ok) say("warn", "the model did not answer every step — the record shows what the host observed");
    await Promise.all([loadTickets(), loadState(), loadEvents()]);
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
    await Promise.all([loadState(), loadEvents(), action === "seed" ? loadTickets() : Promise.resolve()]);
    if (action === "seed") setRuns([]);
  });
  const approve = (approvalId: string) => act("approve", async () => {
    const { message, already } = await api.approve(approvalId);
    say(already ? "warn" : "info", message);
    await Promise.all([loadApprovals(), loadEvents()]);
  });

  const selected = tickets.find((t) => t.ticketId === selectedId) ?? null;
  return (
    <div className="desk">
      <header className="top">
        <a className="brand" href="/">Zu<span>docs</span> <em>desk</em></a>
        <ReleaseBar state={state} />
        <div className="who">
          <span className="muted">{who}</span>
          <button type="button" className="link" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      {notice ? <div className={`notice notice-${notice.tone}`} role="status">{notice.text}<button type="button" className="link" onClick={() => setNotice(null)}>dismiss</button></div> : null}
      <div className="columns">
        <Inbox tickets={tickets} selectedId={selectedId} onSelect={setSelectedId} />
        <main className="centre">
          {selected ? <TicketView ticket={selected} runs={runs} busy={busy} onRun={() => run(selected.ticketId, "run")} onEscalate={() => run(selected.ticketId, "escalate")} onFeedback={feedback} /> : <div className="empty">No tickets yet — re-seed the inbox from the presenter panel.</div>}
        </main>
        <aside className="side">
          <Approvals approvals={approvals} busy={busy} onApprove={approve} />
          <HostCards state={state} />
          <Presenter state={state} busy={busy} selectedTicketId={selectedId} onAction={presenter} environment={config.environment} agentId={config.agentId} />
          <Timeline events={events} />
        </aside>
      </div>
    </div>
  );
}
