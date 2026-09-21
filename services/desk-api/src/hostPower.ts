/**
 * The desk's side of the steady state (phase 8): the eu-west host's power and the demo-mode switch.
 *
 * - **Sleep / Wake the fleet**: the presenter's click invokes the eu-west power function (`services/eu-host/src/power.ts`)
 *   synchronously by its fixed ARN — `sleep` stops the instance, `wake` starts it, `tick` reconciles the status row's
 *   marker with what EC2 says. The answer is the function's own (a refusal names its reason: the wire is cut, a
 *   replacement is in progress, the instance is between states) and lands on the timeline.
 * - **The card while asleep**: the host's status row keeps its last fields; the `power` marker says `stopping`,
 *   `stopped`, `pending` or `running` with the instant it began. `powerView` folds the marker and the row's age
 *   into what the card says — *asleep since …* rather than a stale, degraded host — and `needsReconcile` says when
 *   a poll should ask the function to look now (a marker still in transition, older than a short grace), so the
 *   card settles within a poll or two of a click instead of at the next five-minute tick.
 * - **Demo mode**: one SSM String parameter in the host's region, written by the desk (on for at most four hours,
 *   or off) and read by the workers every minute (`demoMode.ts` holds the document's rules); the desk reads it
 *   for the panel through a short cache so a poll costs no cross-region call.
 *
 * @example
 * ```ts
 * powerView({ state: "stopped", since: "2026-09-21T10:00:12.000Z", at: …, by: "the nightly schedule", instanceId: "i-…" }, "2026-09-21T09:59:50.000Z", Date.now());
 * // { phase: "asleep", since: "2026-09-21T10:00:12.000Z", by: "the nightly schedule", label: "asleep" }
 * needsReconcile({ state: "pending", at: "2026-09-21T16:00:00.000Z", … }, Date.parse("2026-09-21T16:00:30Z"));   // true: still in transition, the grace is over
 * ```
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { demoModeDocument, parseDemoMode, type DemoMode, type DemoModeDoc } from "./demoMode.js";

export type PowerState = "pending" | "running" | "stopping" | "stopped";
export type PowerAction = "sleep" | "wake" | "status" | "tick";

/** The `power` attribute on the eu-west host's status row (written by the power function). */
export interface PowerMarker {
  state: PowerState;
  since: string;
  at: string;
  by: string;
  instanceId: string | null;
}

/** The power function's answer (`services/eu-host/src/power.ts` › PowerAnswer), as the desk reads it. */
export interface PowerAnswer {
  action: PowerAction;
  hostId: string;
  instanceId: string | null;
  state: PowerState | null;
  changed: boolean;
  refusal: string | null;
  marker: PowerMarker | null;
  message: string;
}

/** What the card says about the host's power: awake (no marker, or running and reporting), or one of the four phases. */
export interface PowerView {
  phase: "awake" | "going_to_sleep" | "asleep" | "waking" | "started";
  since: string | null;
  by: string | null;
  label: string;
}

/** Seconds a marker in transition is left alone before a poll asks the function to look (EC2 takes ~30–90 s either way). */
export const RECONCILE_GRACE_SECONDS = 20;

/** The marker and the row's own timestamp folded into what the card says. Pure. */
export function powerView(marker: PowerMarker | null | undefined, writtenAt: string | null | undefined, nowMs: number): PowerView {
  if (!marker) return { phase: "awake", since: null, by: null, label: "awake" };
  switch (marker.state) {
    case "stopping":
      return { phase: "going_to_sleep", since: marker.since, by: marker.by, label: "going to sleep" };
    case "stopped":
      return { phase: "asleep", since: marker.since, by: marker.by, label: "asleep" };
    case "pending":
      return { phase: "waking", since: marker.since, by: marker.by, label: "waking" };
    case "running": {
      // Running per EC2; awake once the workers have written a row since the start began (their boot takes minutes).
      const reported = writtenAt ? Date.parse(writtenAt) > Date.parse(marker.since) : false;
      if (reported) return { phase: "awake", since: marker.since, by: marker.by, label: "awake" };
      const seconds = Math.max(0, Math.round((nowMs - Date.parse(marker.since)) / 1000));
      return { phase: "started", since: marker.since, by: marker.by, label: seconds > 600 ? "started, the workers have not reported" : "started, the workers are coming up" };
    }
    default:
      return { phase: "awake", since: null, by: null, label: "awake" };
  }
}

/** A poll should ask the power function to look now: the marker is in transition and older than the grace. Pure. */
export function needsReconcile(marker: PowerMarker | null | undefined, nowMs: number): boolean {
  if (!marker) return false;
  if (marker.state !== "stopping" && marker.state !== "pending") return false;
  return nowMs - Date.parse(marker.at) >= RECONCILE_GRACE_SECONDS * 1000;
}

/** The power function, invoked synchronously by ARN in its own region; a function error is thrown with its message. */
export async function invokePower(functionArn: string, event: { action: PowerAction; by: string }): Promise<PowerAnswer> {
  const region = functionArn.split(":")[3];
  if (!region) throw new Error(`the power function ARN names no region: ${functionArn}`);
  const out = await new LambdaClient({ region }).send(new InvokeCommand({ FunctionName: functionArn, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(event)) }));
  const parsed = out.Payload ? (JSON.parse(Buffer.from(out.Payload).toString("utf8")) as Record<string, unknown>) : {};
  if (out.FunctionError) throw new Error(String(parsed.errorMessage ?? out.FunctionError).slice(0, 300));
  return parsed as unknown as PowerAnswer;
}

export interface DemoModePorts {
  /** The document as the switch reads now (through the desk's short cache). */
  read(): Promise<DemoModeDoc & { parameter: string }>;
  /** Write the switch: on (until four hours from now) or off, signed by the presenter. */
  write(mode: DemoMode, by: string): Promise<DemoModeDoc & { parameter: string }>;
}

/** Seconds the desk keeps a reading of the switch: a poll every ten seconds costs a cross-region call every thirty. */
export const DEMO_MODE_CACHE_SECONDS = 30;

/** The real ports over SSM in the host's region, by parameter name; a fake in tests. */
export function createDemoModePorts(region: string, parameter: string, now: () => number = Date.now): DemoModePorts {
  const ssm = new SSMClient({ region });
  let cached: { text: string | null; at: number } | null = null;
  const fetchText = async (): Promise<string | null> => {
    try {
      return (await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value ?? null;
    } catch (error) {
      if ((error as Error).name === "ParameterNotFound") return null;
      throw error;
    }
  };
  return {
    async read() {
      if (!cached || now() - cached.at > DEMO_MODE_CACHE_SECONDS * 1000) cached = { text: await fetchText(), at: now() };
      return { ...parseDemoMode(cached.text, now()), parameter };
    },
    async write(mode, by) {
      const text = demoModeDocument(mode, by, now());
      await ssm.send(new PutParameterCommand({ Name: parameter, Value: text, Type: "String", Overwrite: true }));
      cached = { text, at: now() };
      return { ...parseDemoMode(text, now()), parameter };
    },
  };
}
