/**
 * Pure formatting for the desk: the version badge (`reply rev-2 · release #1`), model and arm labels, latency,
 * tokens, money, relative time, and the segmentation of a rendered prompt into runs of plain text and variable
 * values (each labelled with where its value came from, the fenced ones with their fence) for "Why this text".
 * The vocabulary is the customer's: "prompt version" and "release #N"; "generation", "manifest", "slot" and "arm"
 * appear only in tooltips (`TOOLTIPS`).
 *
 * @example
 * ```ts
 * versionBadge("support.reply", "rev-2", 1);   // "reply rev-2 · release #1"
 * segmentRender("Hi <ticket>help</ticket>, tier team.", [{ name: "ticket", value: "help", fenced: true, origin: "call_site", … }, …]);
 * ```
 */
import type { VariableOrigin } from "./api";

export const TOOLTIPS = {
  version: "The prompt version this text was rendered from (its revision in AirPrompter) and the release — the signed generation this host applied.",
  arm: "The experiment arm this customer landed on. Assignment is sticky on the customer id, so every host agrees without coordination.",
  fence: "End-user text is fenced with the variable's name so the model reads it as data, never as instructions.",
  trust: "operator: text the desk vouches for, inserted raw. end_user: text a customer wrote, always fenced.",
  usage: "reported: token counts the provider returned. unavailable: the provider returned none; the window still counts the call.",
  judge: "The prompt's own ## Success criteria, scored by the desk's judge model on this host; only the score leaves.",
  release: "A release is a signed manifest at a generation; hosts pull it and apply it under their own policy.",
  storage: "How the slot store's data key is protected on this host. kms: wrapped by a KMS key. file_key: a 0600 file — reported, never hidden.",
  cap: "Runs per UTC day this host allows. At the line the API refuses with HTTP 429; nothing is simulated.",
} as const;

/** A model's answer as a class-name suffix: lower-case letters and dashes only (an answer is data, a class is not). */
export function slug(value: string | null | undefined): string {
  const cleaned = (value ?? "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "none";
}

export function slotShort(tag: string): string {
  return tag.replace(/^support\./, "").replace(/^escalate\./, "escalate ");
}

export function versionBadge(tag: string, versionId: string | null, generation: number | null): string {
  return `${slotShort(tag)} ${versionId ?? "—"} · release #${generation ?? "—"}`;
}

export const MODEL_LABELS: Record<string, string> = {
  "openai.gpt-5-6-luna": "GPT-5.6 Luna",
  "amazon.nova-micro": "Nova Micro",
  "anthropic.claude-haiku-4-5": "Haiku 4.5",
};

export function modelLabel(model: string | null): string {
  if (!model) return "—";
  return MODEL_LABELS[model] ?? model;
}

export function armLabel(arm: string | null): string {
  if (!arm || arm === "none") return "no experiment";
  return `arm ${arm}`;
}

export function latency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function tokens(t: { input?: number; cachedInput?: number; output?: number } | undefined, source: string | undefined): string {
  if (!t || source === "unavailable") return "usage unavailable";
  const input = (t.input ?? 0) + (t.cachedInput ?? 0);
  return `${input.toLocaleString()} in · ${(t.output ?? 0).toLocaleString()} out`;
}

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19) + "Z";
}

export function score(judge: { score: number | null; taskPass: number; taskFail: number; taskUnclear: number } | null | undefined): string {
  if (!judge) return "—";
  if (judge.score === null) return `unclear (${judge.taskUnclear} unresolved)`;
  return `${judge.taskPass}/${judge.taskPass + judge.taskFail} · ${Math.round(judge.score * 100)}%`;
}

export interface Segment {
  text: string;
  variable?: VariableOrigin;
  /** The fence tags around a fenced value are shown as part of the segment, muted. */
  fence?: "open" | "close";
}

/** The rendered text cut into plain runs and variable values; overlapping matches keep the earliest, longest. */
export function segmentRender(text: string, variables: readonly VariableOrigin[]): Segment[] {
  type Hit = { start: number; end: number; variable: VariableOrigin; fenced: boolean };
  const hits: Hit[] = [];
  for (const variable of variables) {
    if (variable.value === null || variable.value === "") continue;
    const needle = variable.fenced ? `<${variable.name}>${variable.value}</${variable.name}>` : variable.value;
    let from = 0;
    while (from <= text.length) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      hits.push({ start: at, end: at + needle.length, variable, fenced: variable.fenced });
      from = at + needle.length;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start) });
    if (hit.fenced) {
      const open = `<${hit.variable.name}>`;
      const close = `</${hit.variable.name}>`;
      segments.push({ text: open, variable: hit.variable, fence: "open" });
      segments.push({ text: text.slice(hit.start + open.length, hit.end - close.length), variable: hit.variable });
      segments.push({ text: close, variable: hit.variable, fence: "close" });
    } else {
      segments.push({ text: text.slice(hit.start, hit.end), variable: hit.variable });
    }
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

export const ORIGIN_LABELS: Record<VariableOrigin["origin"], string> = { call_site: "call site", your_source: "your source", default: "default", unfilled: "unfilled" };

/** The release bar's sentence from the status rows: the newest generation, how many hosts serve it, what is staged. */
export function releaseSummary(hosts: Array<{ status: { generation?: number; stagedGeneration?: number | null; applyState?: string; lastRefusal?: string | null }; healthz: { status?: string } }>): { generation: number | null; activeOn: number; total: number; staged: number | null; refusal: string | null; failing: number } {
  if (hosts.length === 0) return { generation: null, activeOn: 0, total: 0, staged: null, refusal: null, failing: 0 };
  const generation = Math.max(...hosts.map((h) => h.status.generation ?? 0));
  const activeOn = hosts.filter((h) => (h.status.generation ?? 0) === generation && h.status.applyState === "active").length;
  const staged = hosts.map((h) => h.status.stagedGeneration ?? null).find((g) => g !== null) ?? null;
  const refusal = hosts.map((h) => h.status.lastRefusal ?? null).find((r) => r !== null) ?? null;
  const failing = hosts.filter((h) => h.healthz.status === "failing").length;
  return { generation, activeOn, total: hosts.length, staged, refusal, failing };
}
