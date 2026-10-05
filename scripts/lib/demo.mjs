/**
 * What the demo drivers share, in one place: the ramp a person starts the experiment with in the AirPrompter
 * console, and the small pure helpers the drivers use to observe what the console did from zudocs's own side —
 * which arm a customer is on, per the desk's records; a fleet-agreement check over the desk's status rows; and the
 * generation the environment's public edge pointer names. Nothing here acts on AirPrompter: every change there is a
 * person's act in the console, and the drivers only watch for its effect.
 *
 * @example
 * ```js
 * RAMP;                                             // [{ weightBps: 1000, holdMinutes: 60 }, { weightBps: 5000, holdMinutes: 60 }, { weightBps: 10000 }]
 * fleetAgreement(hosts, 12);                        // { agree: true, rows: [{ hostId, generation }] }
 * await edgeGeneration(config.edgePointerUrl);      // 12, or null when the pointer cannot be read
 * ```
 */

/** The ramp the experiments start with: 10 % for an hour, 50 % for an hour, then everyone — one approval on eu-west unlocks the plan. */
export const RAMP = Object.freeze([{ weightBps: 1000, holdMinutes: 60 }, { weightBps: 5000, holdMinutes: 60 }, { weightBps: 10000 }]);

/** Do the status rows that serve releases agree on a generation? The puller mirrors, the air-gapped host may be down. Pure. */
export function fleetAgreement(hosts, generation, { optional = ["ap-southeast-1/airgap"], staleAfterMs = 15 * 60_000, now = Date.now() } = {}) {
  const rows = hosts.map((h) => ({ hostId: h.hostId, kind: h.kind, generation: Number(h.status?.generation ?? NaN), applyState: h.status?.applyState ?? null, staged: h.status?.stagedGeneration ?? null, stale: now - Date.parse(h.writtenAt) > staleAfterMs }));
  const considered = rows.filter((r) => !(optional.includes(r.hostId) && r.stale));
  const disagree = considered.filter((r) => r.generation !== generation);
  return { agree: disagree.length === 0 && considered.length > 0, generation, rows, disagree };
}

/** The customers on each arm per the desk's stickiness table, for one experiment's slot; pure. */
export function armsByCustomer(stickiness, tag, generation = null) {
  const out = {};
  // One row per customer, slot and release (the weights in force): with no generation asked for, the newest release's row wins.
  const rows = stickiness.filter((s) => s.tag === tag && (generation === null || s.generation === generation)).sort((a, b) => (a.generation ?? -1) - (b.generation ?? -1));
  for (const s of rows) out[s.customerId] = { arms: s.arms, consistent: s.consistent, generation: s.generation ?? null };
  return out;
}

/** A short line for a release: `#7 sha256:612dbc…`. */
export const releaseLine = (generation, digest) => `#${generation} ${digest ? `${digest.slice(0, 19)}…` : "—"}`;

/**
 * The generation the environment's public edge pointer (`…/generation.json`, a CDN document with no key) names, or
 * null when there is no pointer or it cannot be read (the CDN caches it for thirty seconds). What a promotion in
 * the console moved, seen without asking any host.
 */
export async function edgeGeneration(pointerUrl, fetchImpl = globalThis.fetch) {
  if (!pointerUrl) return null;
  try {
    const response = await fetchImpl(pointerUrl);
    if (response.status !== 200) return null;
    const generation = Number((await response.json())?.generation);
    return Number.isInteger(generation) ? generation : null;
  } catch {
    return null;
  }
}
