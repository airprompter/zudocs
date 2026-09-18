/**
 * The desk, signed in: the release bar across the top, the inbox on the left, the ticket and its run panel in
 * the middle, the fleet (host cards), the timeline and the presenter panel on the right. State polls the API —
 * `/state` every 10 s, `/events` every 5 s — because an on_invoke Lambda cannot push. Everything shown is the
 * API's record; the app formats, it never computes a result of its own.
 *
 * @example
 * ```tsx
 * <App api={createApi(config.apiUrl, tokenOf)} config={config} who="seth@zudocs.com" onSignOut={signOut} />
 * ```
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Run, type State, type Ticket, type TimelineEvent } from "./api";
import type { DeskConfig } from "./config";
import { HostCards } from "./components/HostCards";
import { Inbox } from "./components/Inbox";
import { Presenter } from "./components/Presenter";
import { ReleaseBar } from "./components/ReleaseBar";
import { TicketView } from "./components/TicketView";
import { Timeline } from "./components/Timeline";

export interface Notice { tone: "info" | "warn" | "error"; text: string }

export function App({ api, config, who, onSignOut }: { api: Api; config: DeskConfig; who: string; onSignOut: () => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const lastEventAt = useRef<string | null>(null);

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
    try { setState(await api.state()); } catch (error) { failed(error); }
  }, [api, failed]);
  const loadEvents = useCallback(async () => {
    try {
      const { events: fresh } = await api.events(lastEventAt.current);
      if (fresh.length === 0) return;
      lastEventAt.current = fresh[fresh.length - 1]!.at;
      setEvents((current) => [...current, ...fresh].slice(-200));
    } catch { /* the next poll tries again; a timeline gap is not worth a banner */ }
  }, [api]);

  useEffect(() => { void loadTickets(); void loadState(); void loadEvents(); }, [loadTickets, loadState, loadEvents]);
  useEffect(() => {
    const s = setInterval(() => void loadState(), 10_000);
    const e = setInterval(() => void loadEvents(), 5_000);
    return () => { clearInterval(s); clearInterval(e); };
  }, [loadState, loadEvents]);
  useEffect(() => { if (selectedId) void loadRuns(selectedId); else setRuns([]); }, [selectedId, loadRuns]);

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
          <HostCards state={state} />
          <Presenter state={state} busy={busy} onAction={presenter} environment={config.environment} agentId={config.agentId} />
          <Timeline events={events} />
        </aside>
      </div>
    </div>
  );
}
