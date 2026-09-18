/**
 * The seeded inbox: Zudocs' customers and the tickets they wrote — synthetic, about a documentation product
 * (search, permissions, publishing, billing), with stable ids so the sticky experiment `subject` (the customer id)
 * lands the same customer on the same arm on every host and every re-seed. Ticket text is end-user data: it is
 * fenced by the prompts and never logged by the API. The customer table is the source of the `customer_tier`
 * variable the reply prompt declares as runtime-filled.
 *
 * @example
 * ```ts
 * SEED_CUSTOMERS.find((c) => c.customerId === "cust-3003")?.tier;   // "enterprise" → the desk passes tone: "formal"
 * SEED_TICKETS.length;                                             // 12
 * ```
 */
import type { Customer, Ticket } from "./store.js";

export const SEED_CUSTOMERS: readonly Customer[] = Object.freeze([
  { customerId: "cust-1001", name: "Acme Docs", tier: "team", seats: 14, since: "2025-03-11" },
  { customerId: "cust-2002", name: "Nimbus Labs", tier: "trial", seats: 3, since: "2026-09-02" },
  { customerId: "cust-3003", name: "Orbital Bank", tier: "enterprise", seats: 240, since: "2024-11-20" },
  { customerId: "cust-4004", name: "Fernwood Studio", tier: "team", seats: 6, since: "2026-01-14" },
  { customerId: "cust-5005", name: "Larkspur Health", tier: "enterprise", seats: 88, since: "2025-07-01" },
  { customerId: "cust-6006", name: "Pocket Atlas", tier: "trial", seats: 1, since: "2026-09-15" },
]);

const t = (ticketId: string, customerId: string, channel: Ticket["channel"], receivedAt: string, subject: string, body: string): Ticket => ({ ticketId, customerId, channel, receivedAt, subject, body, lastRun: null });

export const SEED_TICKETS: readonly Ticket[] = Object.freeze([
  t("T-1041", "cust-1001", "email", "2026-09-18T08:12:00Z", "Deleted page still shows in search", "Search still returns a page we deleted last week (\"Release notes 2.3\"). Clicking it gives a 404. We have re-published the space twice. Is the index stuck?"),
  t("T-1042", "cust-2002", "chat", "2026-09-18T08:40:00Z", "Can a viewer edit pages?", "One of our viewers says she was able to edit a page yesterday. She is definitely a viewer in the members list. Is that expected during the trial, or is something wrong with permissions?"),
  t("T-1043", "cust-3003", "email", "2026-09-18T09:05:00Z", "Public site returning 502 since this morning", "Our public documentation site (docs.orbitalbank.example) has been returning 502 errors since about 07:30 UTC. The editor works fine. This is customer-facing, please treat as urgent."),
  t("T-1044", "cust-4004", "form", "2026-09-18T09:30:00Z", "Charged twice this month", "We were charged twice on the 15th — two invoices for the same Team plan, same amount. Can you refund one and tell me why it happened?"),
  t("T-1045", "cust-5005", "email", "2026-09-18T09:55:00Z", "Dark mode for the reader", "Would it be possible to add a dark mode to the published docs? Several of our on-call engineers read runbooks at night. Not urgent, just a request."),
  t("T-1046", "cust-1001", "chat", "2026-09-18T10:20:00Z", "Search ignores code blocks", "When I search for an error string that only appears inside a code block (for example ERR_TOKEN_EXPIRED), nothing comes back. Searching the same words in normal text works. Are code blocks excluded from the index?"),
  t("T-1047", "cust-6006", "form", "2026-09-18T10:45:00Z", "How do I invite a teammate on the trial?", "I started a trial yesterday and want to invite one colleague to try it with me. I can't find where to do that. Does the trial allow more than one person?"),
  t("T-1048", "cust-3003", "email", "2026-09-18T11:10:00Z", "SSO users lose editor role after login", "Since Monday, people signing in through our SSO are downgraded to viewer on each login even though they were editors. We have 40 writers affected. Please escalate."),
  t("T-1049", "cust-2002", "chat", "2026-09-18T11:35:00Z", "Publish button greyed out", "The Publish button is greyed out on our getting-started space. Nothing changed on our side. The page saves fine as a draft. What are we missing?"),
  t("T-1050", "cust-4004", "email", "2026-09-18T12:00:00Z", "Custom domain certificate expired", "The certificate on our custom domain (help.fernwood.example) expired today and visitors get a browser warning. We set it up through your dashboard eight months ago. Does it not renew?"),
  t("T-1051", "cust-5005", "form", "2026-09-18T12:25:00Z", "Invoice needs our PO number", "Our accounts team needs the purchase order number printed on the invoice or they will not pay it. Where can I add that for future invoices, and can this month's be reissued?"),
  t("T-1052", "cust-1001", "email", "2026-09-18T12:50:00Z", "Export to PDF cuts off tables", "Exporting a long page to PDF cuts wide tables off at the right edge. The web version scrolls, the PDF just truncates. Is there a landscape option or a way to fit tables?"),
]);
