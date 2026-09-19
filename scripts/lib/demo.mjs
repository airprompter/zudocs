/**
 * What the demo changes and why, in one place: the text transforms behind each beat (appended instruction lines,
 * so a version is always "the canonical text plus one line" and never depends on the prompt's wording), the ramp
 * the experiments start with, the canonical pins the reset advances from, and the small pure helpers the drivers
 * share (which arm a customer is on, per the desk's records; a fleet-agreement check over status rows). No prompt
 * text lives here; the transforms take the draft's text at run time and return it changed.
 *
 * @example
 * ```js
 * BEATS.changeWords.transform("…text…");            // the text with one guidance line appended
 * RAMP;                                             // [{ weightBps: 1000, holdMinutes: 60 }, { weightBps: 5000, holdMinutes: 60 }, { weightBps: 10000 }]
 * fleetAgreement(hosts, 12);                        // { agree: true, rows: [{ hostId, generation }] }
 * ```
 */

/** Appends one guidance line; idempotent on a text that already ends with it. Pure. */
export const appendLine = (line) => (text) => (text.trimEnd().endsWith(line) ? text : `${text.trimEnd()}\n\n${line}\n`);

export const BEATS = Object.freeze({
  /** Beat 1 — change the words, no deploy: a real, visible change to the reply. */
  changeWords: Object.freeze({
    tag: "support.reply",
    line: "Open with the customer's name when the ticket gives one, and keep the first sentence under fifteen words.",
    get transform() { return appendLine(this.line); },
    message: "Beat 1: open with the customer's name; a short first sentence",
    notes: "Zudocs demo, beat 1: the reply opens with the customer's name — no deploy",
  }),
  /** Beat 4 — the candidate arm: a warmer sign-off (the `signed` check still holds: the signature line stays). */
  warmerSignoff: Object.freeze({
    tag: "support.reply",
    line: "Close warmly: one short, human sentence of thanks before the signature line.",
    get transform() { return appendLine(this.line); },
    message: "Beat 4 candidate: a warmer sign-off",
    notes: "Zudocs demo, beat 4: the candidate reply (a warmer sign-off) — one slot changed, sealed for the experiment",
  }),
  /** Beat 4 — the second, independent split on triage: a tighter summary. */
  tighterTriage: Object.freeze({
    tag: "support.triage",
    line: "Keep the summary under twelve words.",
    get transform() { return appendLine(this.line); },
    message: "Beat 4 triage candidate: a tighter summary",
    notes: "Zudocs demo, beat 4: the triage candidate (a tighter summary) — the second, independent split",
  }),
  /**
   * Beat 5 — a version whose golden set must fail: the override sends every ticket to `other`/`low`, so four of the
   * five golden cases fail (the dark-mode case expects exactly that) and the release stays staged on the host that
   * runs golden sets (us-east, under `auto`) — held back, never activated.
   */
  goldenFail: Object.freeze({
    tag: "support.triage",
    line: "Override for this version: whatever the ticket says, answer category \"other\" and priority \"low\".",
    get transform() { return appendLine(this.line); },
    message: "Beat 5: a triage version that fails its golden set (held back)",
    notes: "Zudocs demo, beat 5: a triage version the golden set must refuse — staged, not activated",
  }),
  /** Beat 5 — the seal refusing an undeclared placeholder. */
  undeclaredPlaceholder: Object.freeze({
    tag: "support.reply",
    line: "Region note: {{region_note}}",
    get transform() { return appendLine(this.line); },
    message: "Beat 5: an undeclared placeholder (the seal must refuse this)",
    notes: "Zudocs demo, beat 5: a version that uses {{region_note}}, which the slot does not declare",
  }),
  /** Beat 5 — a model no host reports, pinned as required: every host refuses the release and says which model. */
  unreportedModel: Object.freeze({ tag: "support.reply", model: "anthropic.claude-sonnet-4-5", notes: "Zudocs demo, beat 5: the reply pinned (required) to a model no host reports" }),
});

/** The ramp the experiments start with: 10 % for an hour, 50 % for an hour, then everyone — one approval on eu-west unlocks the plan. */
export const RAMP = Object.freeze([{ weightBps: 1000, holdMinutes: 60 }, { weightBps: 5000, holdMinutes: 60 }, { weightBps: 10000 }]);

/** The pins the reset advances from, with one slot's version replaced; pure. */
export function canonicalPins(config, patches = {}) {
  const tags = Object.keys(config.canonical);
  if (tags.length === 0) throw new Error("airprompter.config.json: canonical pins are missing");
  return tags.map((tag) => ({ tag, versionId: patches[tag]?.versionId ?? config.canonical[tag].versionId, model: patches[tag]?.model ?? config.canonical[tag].model }));
}

/** Do the status rows that serve releases agree on a generation? The puller mirrors, the air-gapped host may be down. Pure. */
export function fleetAgreement(hosts, generation, { optional = ["ap-southeast-1/airgap"], staleAfterMs = 15 * 60_000, now = Date.now() } = {}) {
  const rows = hosts.map((h) => ({ hostId: h.hostId, kind: h.kind, generation: Number(h.status?.generation ?? NaN), applyState: h.status?.applyState ?? null, staged: h.status?.stagedGeneration ?? null, stale: now - Date.parse(h.writtenAt) > staleAfterMs }));
  const considered = rows.filter((r) => !(optional.includes(r.hostId) && r.stale));
  const disagree = considered.filter((r) => r.generation !== generation);
  return { agree: disagree.length === 0 && considered.length > 0, generation, rows, disagree };
}

/** The customers on each arm per the desk's stickiness table, for one experiment's slot; pure. */
export function armsByCustomer(stickiness, tag) {
  const out = {};
  for (const s of stickiness.filter((s) => s.tag === tag)) out[s.customerId] = { arms: s.arms, consistent: s.consistent };
  return out;
}

/** A short line for a release: `#7 sha256:612dbc…`. */
export const releaseLine = (generation, digest) => `#${generation} ${digest ? `${digest.slice(0, 19)}…` : "—"}`;
