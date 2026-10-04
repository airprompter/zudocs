/**
 * The desk's pages. One pure parser, so a refresh and a click land on the same page.
 * `/callback` is the Cognito return and is not a page; `main` checks it before this runs.
 *
 * @example
 * ```ts
 * parseDeskRoute("/");                // "agent" (the inbox)
 * deskHref("daemon", "T-1041");       // "/daemon?ticket=T-1041"
 * ```
 */

import type { HostStatus, State } from "./api";

export type DeskRoute = "architecture" | "agent" | "daemon" | "operate";

export const PAGE_LABEL: Record<DeskRoute, string> = {
  architecture: "Hosts",
  agent: "Inbox",
  daemon: "Europe",
  operate: "Operator",
};

const PATH: Record<DeskRoute, string> = {
  architecture: "/fleet",
  agent: "/",
  daemon: "/daemon",
  operate: "/operate",
};

/** Exact match. A trailing slash is a different path and is not the callback. */
export function isSignInCallback(pathname: string): boolean {
  return pathname === "/callback";
}

/** Strip one trailing slash. `/` and `/agent` are the inbox. An unknown path is the inbox. */
export function parseDeskRoute(pathname: string): DeskRoute {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  switch (path) {
    case "/":
    case "/agent":
      return "agent";
    case "/fleet":
      return "architecture";
    case "/daemon":
      return "daemon";
    case "/operate":
      return "operate";
    default:
      return "agent";
  }
}

export function ticketParam(search: string): string | null {
  const value = new URLSearchParams(search).get("ticket");
  if (!value || !value.trim()) return null;
  return value;
}

export function deskHref(route: DeskRoute, ticket: string | null): string {
  const path = PATH[route];
  if (!ticket) return path;
  return `${path}?ticket=${encodeURIComponent(ticket)}`;
}

export type LitPath = "none" | "sdk" | "daemon";

/** Which arrow lights: the newest run's host compared with the function and the daemon row. */
export function litPath(route: "agent" | "daemon", runHost: string | null, lambdaHostId: string | null, daemonHostId: string | null): LitPath {
  if (!runHost) return "none";
  switch (route) {
    case "agent":
      return lambdaHostId !== null && runHost === lambdaHostId ? "sdk" : "none";
    case "daemon":
      return daemonHostId !== null && runHost === daemonHostId ? "daemon" : "none";
    default: {
      const unexpected: never = route;
      return unexpected;
    }
  }
}

/** The other page, when the newest run was made by the other host. */
export function mismatchRoute(route: "agent" | "daemon", runHost: string, lambdaHostId: string | null, daemonHostId: string | null): "agent" | "daemon" | null {
  switch (route) {
    case "agent":
      return daemonHostId !== null && runHost === daemonHostId ? "daemon" : null;
    case "daemon":
      return lambdaHostId !== null && runHost === lambdaHostId ? "agent" : null;
    default: {
      const unexpected: never = route;
      return unexpected;
    }
  }
}

export function newestHost(runs: readonly { host: string; at: string }[]): string | null {
  if (runs.length === 0) return null;
  const newest = [...runs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  return newest ? newest.host : null;
}

/** The Inbox traces the visible reply; Europe traces its daemon approval host. */
export function releaseHostId(route: DeskRoute, runHost: string | null, lambdaHostId: string | null, daemonHostId: string | null): string | null {
  if (route === "daemon") return daemonHostId;
  if (route === "agent" && (runHost === lambdaHostId || runHost === daemonHostId)) return runHost;
  return lambdaHostId;
}

/** The inbox's fresh sync result supersedes its periodic database row; other hosts use their own saved reports. */
export function supportHostSnapshot(state: Pick<State, "host" | "hosts"> | null, hostId: string | null): HostStatus | null {
  if (!state || !hostId) return null;
  if (hostId !== state.host.hostId) return state.hosts.find((host) => host.hostId === hostId) ?? null;
  const live = state.host;
  return {
    hostId, region: live.region, kind: "lambda", sdk: live.sdk, reportSource: "live",
    writtenAt: typeof live.status.lastSyncAt === "string" ? live.status.lastSyncAt : live.startedAt,
    status: live.status, healthz: live.healthz,
    container: { instanceId: live.instanceId, coldStart: live.coldStart, startedAt: live.startedAt, invocations: live.invocations },
  };
}
