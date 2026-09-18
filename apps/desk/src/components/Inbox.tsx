/**
 * The inbox: every seeded ticket with its customer and plan, and — once a run happened — the triage category and
 * priority the model answered, plus the prompt version that replied. Selecting one opens it in the centre.
 *
 * @example
 * ```tsx
 * <Inbox tickets={tickets} selectedId={id} onSelect={setId} />
 * ```
 */
import type { Ticket } from "../api";
import { ago } from "../format";

export function Inbox({ tickets, selectedId, onSelect }: { tickets: Ticket[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <nav className="inbox" aria-label="Inbox">
      <div className="pane-title">
        <h2>Inbox</h2>
        <span className="muted">{tickets.length} open</span>
      </div>
      <ul>
        {tickets.map((t) => (
          <li key={t.ticketId}>
            <button type="button" className={`ticket-row${t.ticketId === selectedId ? " selected" : ""}`} onClick={() => onSelect(t.ticketId)}>
              <div className="ticket-row-top">
                <span className="ticket-id">{t.ticketId}</span>
                <span className="muted">{ago(t.receivedAt)}</span>
              </div>
              <div className="ticket-subject">{t.subject}</div>
              <div className="ticket-row-meta">
                <span>{t.customer?.name ?? t.customerId}</span>
                <span className={`chip tier-${t.customer?.tier ?? "unknown"}`}>{t.customer?.tier ?? "—"}</span>
                {t.lastRun?.category ? <span className={`chip cat-${t.lastRun.category}`}>{t.lastRun.category}</span> : null}
                {t.lastRun?.priority ? <span className={`chip prio-${t.lastRun.priority}`}>{t.lastRun.priority}</span> : null}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
