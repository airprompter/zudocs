/**
 * Demo mode on the eu-west host: the parameter read (one SSM String in the host's region, by name, every minute) and
 * the ticket timer under the switch. The document's rules live in the desk API's `demoMode.ts` (one parser for
 * every reader — the workers, the power function's nightly schedule, the desk): on only while a document says so
 * and its `until` is ahead; anything else is off, with the reason.
 *
 * `TicketCadence` is the worker's timer: a mode change pulls the next ticket forward to at most one new interval
 * away and never further out, so switching on is felt within two minutes and switching off lets the ticket already
 * due run.
 *
 * @example
 * ```ts
 * const cadence = new TicketCadence({ idle: 3600, demo: 120 }, "off", Date.now(), 90_000);
 * cadence.setMode(parseDemoMode(await readDemoModeParameter(ssm, "/zudocs/dev/demo-mode"), Date.now()).mode, Date.now());
 * if (cadence.due(Date.now())) runOne();        // every scheduler tick
 * ```
 */
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { DemoMode } from "../../desk-api/src/demoMode.js";

export { DEMO_MODE_MAX_HOURS, OFF, demoModeDocument, parseDemoMode, type DemoMode, type DemoModeDoc } from "../../desk-api/src/demoMode.js";

/** The parameter, read by name: its text, or null when it does not exist. Any other failure throws (the caller keeps its last reading). */
export async function readDemoModeParameter(ssm: Pick<SSMClient, "send">, name: string): Promise<string | null> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name }));
    return out.Parameter?.Value ?? null;
  } catch (error) {
    if ((error as Error).name === "ParameterNotFound") return null;
    throw error;
  }
}

/** The worker's ticket timer under the switch. Pure over the instants it is given. */
export class TicketCadence {
  private nextAtMs: number;
  private currentMode: DemoMode;

  constructor(private readonly intervals: { readonly idle: number; readonly demo: number }, mode: DemoMode, nowMs: number, firstDelayMs?: number) {
    this.currentMode = mode;
    this.nextAtMs = nowMs + (firstDelayMs ?? this.intervalSeconds * 1000);
  }

  get mode(): DemoMode {
    return this.currentMode;
  }

  /** Seconds between tickets under the current mode. */
  get intervalSeconds(): number {
    return this.currentMode === "on" ? this.intervals.demo : this.intervals.idle;
  }

  get nextAt(): string {
    return new Date(this.nextAtMs).toISOString();
  }

  /** True once per interval: the ticket is due, and the next one is scheduled from now. */
  due(nowMs: number): boolean {
    if (nowMs < this.nextAtMs) return false;
    this.nextAtMs = nowMs + this.intervalSeconds * 1000;
    return true;
  }

  /** A mode change: the next ticket comes forward to at most one new interval away; it never moves further out. */
  setMode(mode: DemoMode, nowMs: number): boolean {
    if (mode === this.currentMode) return false;
    this.currentMode = mode;
    this.nextAtMs = Math.min(this.nextAtMs, nowMs + this.intervalSeconds * 1000);
    return true;
  }
}
