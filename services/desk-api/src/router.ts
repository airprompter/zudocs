/**
 * The desk API's routes as data: method + path pattern → a name and its parameters, matched on the event's
 * `rawPath` (an HTTP API integration delivers `pathParameters` only for parameterised route keys; matching the raw
 * path keeps the handler correct whichever way the route is registered). Pure; the handler dispatches on the name.
 *
 * @example
 * ```ts
 * match("POST", "/tickets/T-1041/run");     // { name: "run_ticket", params: { ticketId: "T-1041" } }
 * match("GET", "/nope");                    // null
 * ROUTES.map((r) => `${r.method} ${r.pattern}`);   // what the stack registers, one JWT-authorised route each
 * ```
 */

export type RouteName = "list_tickets" | "get_ticket" | "run_ticket" | "escalate_ticket" | "hosted_run" | "feedback" | "state" | "events" | "arms" | "list_approvals" | "approve" | "presenter" | "healthz";

export interface Route {
  method: "GET" | "POST";
  /** The API Gateway route key form: `{param}` segments. */
  pattern: string;
  name: RouteName;
}

export const ROUTES: readonly Route[] = Object.freeze([
  { method: "GET", pattern: "/tickets", name: "list_tickets" },
  { method: "GET", pattern: "/tickets/{ticketId}", name: "get_ticket" },
  { method: "POST", pattern: "/tickets/{ticketId}/run", name: "run_ticket" },
  { method: "POST", pattern: "/tickets/{ticketId}/escalate", name: "escalate_ticket" },
  { method: "POST", pattern: "/tickets/{ticketId}/hosted-run", name: "hosted_run" },
  { method: "POST", pattern: "/runs/{runId}/feedback", name: "feedback" },
  { method: "GET", pattern: "/state", name: "state" },
  { method: "GET", pattern: "/events", name: "events" },
  { method: "GET", pattern: "/arms", name: "arms" },
  { method: "GET", pattern: "/approvals", name: "list_approvals" },
  { method: "POST", pattern: "/approvals/{approvalId}/approve", name: "approve" },
  { method: "POST", pattern: "/presenter/{action}", name: "presenter" },
  { method: "GET", pattern: "/healthz", name: "healthz" },
]);

const SEGMENT = /^[A-Za-z0-9_.:-]{1,64}$/;

export function match(method: string, rawPath: string): { name: RouteName; params: Record<string, string> } | null {
  const path = rawPath.replace(/\/+$/, "") || "/";
  const segments = path.split("/").slice(1);
  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const parts = route.pattern.split("/").slice(1);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const segment = decodeURIComponent(segments[i]!);
      if (part.startsWith("{")) {
        if (!SEGMENT.test(segment)) { ok = false; break; }
        params[part.slice(1, -1)] = segment;
      } else if (part !== segment) { ok = false; break; }
    }
    if (ok) return { name: route.name, params };
  }
  return null;
}
