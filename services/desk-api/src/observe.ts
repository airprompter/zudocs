/**
 * The tap: every model observation the SDK files (latency, tokens, usage source, checks counts, error class) is also
 * handed to the request that made the call, so the desk shows the SDK's numbers and never its own stopwatch. The
 * spool writer is a public property and every wrapper files through `spool.observe`, so an own property shadowing
 * the method sees each observation before the original writes it (an `onObservation` listener on the SDK would make
 * this a contract; filed as a gap). Shared by the us-east host and the eu-west worker.
 *
 * @example
 * ```ts
 * tapObservations(ap);                                     // idempotent: tapping twice keeps one tap
 * const { result, observations } = await collectObservations(() => callers.complete(rendered));
 * ```
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Observation } from "@airprompter/agent-sdk";

const capture = new AsyncLocalStorage<Observation[]>();
const TAPPED = Symbol("zudocs.tapped");

export type Observed<T> = { result: T; error?: undefined; observations: Observation[] } | { result?: undefined; error: unknown; observations: Observation[] };

export function tapObservations(ap: { spool: { observe: (observation: Observation, nowMs: number) => void } }): void {
  const spool = ap.spool as { observe: (observation: Observation, nowMs: number) => void; [TAPPED]?: boolean };
  if (spool[TAPPED]) return;
  const original = spool.observe.bind(spool);
  spool.observe = (observation, nowMs) => {
    capture.getStore()?.push(observation);
    return original(observation, nowMs);
  };
  spool[TAPPED] = true;
}

/** Run `fn` with the observations the SDK files during it collected — on a failure too; never throws. */
export async function collectObservations<T>(fn: () => Promise<T>): Promise<Observed<T>> {
  const observations: Observation[] = [];
  // The wrappers file the observation when the call settles, one turn after the caller sees the result (or the
  // error): give the spool that turn — a bounded wait, so a call the wrapper never attributed still returns.
  const settled = await capture.run(observations, () => fn().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })));
  for (let waited = 0; observations.length === 0 && waited < 500; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  return settled.ok ? { result: settled.value, observations } : { error: settled.error, observations };
}
