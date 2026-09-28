/**
 * The inbox: every open ticket as a support queue — customer, subject, plan, and once a reply
 * happened the triage category and priority. Selecting one opens it in the centre.
 *
 * @example
 * ```tsx
 * <Inbox tickets={tickets} selectedId={id} onSelect={setId} />
 * ```
 */
import type { Ticket } from "../api";
import { ago, slug } from "../format";

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
            <button type="button" className={`ticket-row${t.ticketId === selectedId ? " selected" : ""}${slug(t.lastRun?.priority) === "urgent" ? " urgent" : ""}`} onClick={() => onSelect(t.ticketId)}>
              <div className="ticket-row-top">
                <span className="ticket-customer">{t.customer?.name ?? t.customerId}</span>
                <span className="muted">{ago(t.receivedAt)}</span>
              </div>
              <div className="ticket-subject">{t.subject}</div>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
