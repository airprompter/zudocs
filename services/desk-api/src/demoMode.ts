/**
 * Demo mode, the pure half: the document the desk writes to the eu-west demo-mode parameter and the fail-closed
 * rules every reader applies (the eu-west workers, the power function's nightly schedule, the desk's own state
 * route). Idle, the eu-west workers run a ticket an hour (Node) and every two hours (Python); with demo mode on they
 * run one every two and five minutes, so the eu-west card moves while a prospect watches. The switch is an SSM
 * String parameter in the host's region (`/zudocs/<environment>/demo-mode`) holding a small JSON document:
 *
 *     {"mode":"on","until":"2026-09-21T20:00:00.000Z","by":"seth@zudocs.com","at":"2026-09-21T16:00:00.000Z"}
 *
 * Demo mode is *on* only when the document parses, says `on`, carries an `until` instant, and that instant is still
 * ahead and no further than `DEMO_MODE_MAX_HOURS` — no expiry, an unreadable document, an unknown mode, a lapsed or
 * an overlong instant all read as *off*, with the reason, so a status row says why. A session that forgets the
 * switch costs at most four hours of demo cadence. The eu-west side (`services/eu-host/src/demoMode.ts`) adds the
 * parameter read and the ticket timer under the switch.
 *
 * @example
 * ```ts
 * parseDemoMode('{"mode":"on","until":"2026-09-21T20:00:00.000Z"}', Date.parse("2026-09-21T16:00:00Z"));   // { mode: "on", until: "2026-09-21T20:00:00.000Z", by: null, reason: null }
 * parseDemoMode("on", Date.now());                                                                           // { mode: "off", …, reason: "unparseable" }
 * demoModeDocument("on", "seth@zudocs.com", Date.now());                                                     // the text the desk puts in the parameter
 * ```
 */

export type DemoMode = "on" | "off";
/** The longest a demo-mode switch may stay on: the desk writes `until = now + this`, the readers refuse a longer or missing one. */
export const DEMO_MODE_MAX_HOURS = 4;

export interface DemoModeDoc {
  mode: DemoMode;
  /** When the switch lapses on its own (present whenever the mode is on). */
  until: string | null;
  by: string | null;
  /** Why an `on` document reads as off: unparseable, unknown_mode, no_expiry, expired, too_long, absent — null when the mode is what the document says. */
  reason: string | null;
}

export const OFF: DemoModeDoc = Object.freeze({ mode: "off", until: null, by: null, reason: null });

/** The parameter's text as every reader takes it: on only when everything about the document says so. Pure. */
export function parseDemoMode(text: string | null | undefined, nowMs: number): DemoModeDoc {
  if (text === null || text === undefined || !text.trim()) return { ...OFF, reason: "absent" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ...OFF, reason: "unparseable" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ...OFF, reason: "unparseable" };
  const d = doc as Record<string, unknown>;
  const by = typeof d.by === "string" && d.by.trim() ? d.by.trim().slice(0, 120) : null;
  if (d.mode === "off") return { mode: "off", until: null, by, reason: null };
  if (d.mode !== "on") return { ...OFF, by, reason: "unknown_mode" };
  const until = typeof d.until === "string" ? Date.parse(d.until) : Number.NaN;
  if (!Number.isFinite(until)) return { ...OFF, by, reason: "no_expiry" };
  if (until <= nowMs) return { mode: "off", until: new Date(until).toISOString(), by, reason: "expired" };
  if (until - nowMs > DEMO_MODE_MAX_HOURS * 3_600_000 + 60_000) return { ...OFF, by, reason: "too_long" };
  return { mode: "on", until: new Date(until).toISOString(), by, reason: null };
}

/** The document the desk writes: on until `DEMO_MODE_MAX_HOURS` from now, or off. Pure. */
export function demoModeDocument(mode: DemoMode, by: string, nowMs: number): string {
  const at = new Date(nowMs).toISOString();
  return JSON.stringify(mode === "on" ? { mode, until: new Date(nowMs + DEMO_MODE_MAX_HOURS * 3_600_000).toISOString(), by, at } : { mode, by, at });
}
