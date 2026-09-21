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
 * releaseSummary(hosts).staged;                // { generation: 2, hosts: ["eu-west-1"] } — what the bar says is awaiting approval
 * mergeEvents(current, fresh);                 // the timeline without a row shown twice
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
  approval: "This host's policy is unlock_required: AirPrompter stages a release and only your approval (or an operator's unlock on the host) makes it live. The console can request an unlock; it can never grant one.",
  daemon: "airprompterd: one sync loop and one store per host, served to every attached SDK over a local socket; the workers hold no key.",
  ignoredByContract: "The hosted route accepts these OpenAI parameters and ignores them by contract: the sealed version owns its settings. The response carries no settings, so this is the contract's word, not an observation.",
  lease: "How long this host may keep serving without hearing from AirPrompter. After it lapses the host degrades (keeps serving, says so) — the wire-cut drill shows it.",
  wire: "Cut: the host's outbound rules are replaced so only the desk's tables stay reachable — AirPrompter and Bedrock go dark and the card shows it. A rule restores the wire 15 minutes after a cut whatever happens.",
  puller: "The fleet pattern: one function holds the Agent key for the region and pulls each promoted release pointer-first (an idle interval is one CDN read, no API call) into a table and an exchange bucket. Runtimes behind it hold no key.",
  nudge: "The change-notification placeholder: one message on a queue the company owns. The puller reads the origin now instead of waiting for its schedule. A nudge can only say \"look\" — pull-and-verify stays the only source of truth.",
  airgap: "A host with no route out: no internet gateway, no NAT. It reads the exchange bucket and the releases table through gateway endpoints, applies each bundle the puller sealed to its key, and cannot call a model — every render it files is a refusal, never an invented answer. Its telemetry leaves by export and arrives by import on eu-west.",
  distributionKey: "The X25519 keypair airprompter keygen generated on the host at first boot. Only the public half left it (to the exchange); the puller seals every bundle to it; the private half opens them and never leaves.",
  hosted: "Hosted staging: the same prompts run on AirPrompter's own execution with a run key bound to one environment — no store, no model key of ours. The stream is replayed as it arrived; the compatible endpoint shows the caller's temperature marked ignored by contract beside the version's sealed settings (the response carries no settings; the mark is the contract's word).",
  hostCli: "The operator's CLI on the eu-west host, through Session Manager's Run Command, targeted by the instance's Name tag: a fixed list of zudocs-cli commands; the CLI's own document lands on the timeline. Nothing typed here reaches a shell.",
  frozen: "A signed disable directive on the manifest: a host that syncs stops rendering the moment the manifest verifies. On the daemon host the workers render from the active release, so the frozen generation takes effect there when it is approved (SDK #51). Only the console lifts it.",
  golden: "The golden set: cases with expected outputs, run against the pinned model on this host before a staged release activates (under auto too). Below the floor, the release stays staged.",
  policyLocal: "This host's own apply policy, set by an operator through the SDK. auto loosens a pin the console tightened; unlock_required tightens it by hand. The console's setting is advisory once a host is pinned.",
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
  "amazon.nova-2-lite": "Nova 2 Lite",
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

/** "in 42m" / "in 3h 05m" / "expired 2m ago" — the lease as a countdown; "—" when there is none. */
export function countdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const delta = Math.round((Date.parse(iso) - now) / 1000);
  if (!Number.isFinite(delta)) return "—";
  const abs = Math.abs(delta);
  const text = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m` : `${Math.floor(abs / 3600)}h ${String(Math.floor((abs % 3600) / 60)).padStart(2, "0")}m`;
  return delta >= 0 ? `in ${text}` : `expired ${text} ago`;
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

/** The release bar's sentence from the status rows: the newest generation, how many hosts serve it, what is staged and where. */
type HostStatusLike = { generation?: number; stagedGeneration?: number | null; applyState?: string; lastRefusal?: string | null; lastSyncOutcome?: string | null; consecutiveSyncFailures?: number };

/**
 * A `network:` refusal the SDK still reports after the wire came back: it sets `lastRefusal` (and `applyState:
 * refused`) on a failed poll and clears it only on the next activation, not on the next successful poll (filed
 * upstream). When the last poll succeeded and nothing is failing, the refusal is history, not the host's state.
 */
export function staleRefusal(status: HostStatusLike): boolean {
  const refusal = status.lastRefusal ?? null;
  if (!refusal || !refusal.startsWith("network:")) return false;
  return (status.consecutiveSyncFailures ?? 0) === 0 && status.lastSyncOutcome !== "unavailable" && status.lastSyncOutcome !== null && status.lastSyncOutcome !== undefined;
}

/** The apply state as the desk reads it: `refused` by a stale network refusal is `active` (the release it serves is unchanged). */
export function effectiveApplyState(status: HostStatusLike): string | undefined {
  return status.applyState === "refused" && staleRefusal(status) && (status.generation ?? 0) > 0 ? "active" : status.applyState;
}

export function releaseSummary(allHosts: Array<{ hostId?: string; region?: string; kind?: string; status?: HostStatusLike; healthz?: { status?: string } }>): { generation: number | null; activeOn: number; total: number; staged: { generation: number; hosts: string[] } | null; refusal: string | null; staleRefusal: string | null; failing: number; degraded: number; exchange: number | null } {
  // The puller is not a host that serves prompts: it reports the generation the exchange holds, which the bar shows beside the count.
  const hosts = allHosts.filter((h) => h.kind !== "puller");
  const exchange = allHosts.find((h) => h.kind === "puller")?.status?.generation ?? null;
  if (hosts.length === 0) return { generation: null, activeOn: 0, total: 0, staged: null, refusal: null, staleRefusal: null, failing: 0, degraded: 0, exchange };
  const statusOf = (h: (typeof hosts)[number]) => h.status ?? {};
  const generation = Math.max(...hosts.map((h) => Math.max(statusOf(h).generation ?? 0, statusOf(h).stagedGeneration ?? 0)));
  const activeOn = hosts.filter((h) => (statusOf(h).generation ?? 0) === generation && effectiveApplyState(statusOf(h)) === "active").length;
  const stagedHosts = hosts.filter((h) => (statusOf(h).stagedGeneration ?? null) !== null);
  const staged = stagedHosts.length > 0 ? { generation: Math.max(...stagedHosts.map((h) => statusOf(h).stagedGeneration!)), hosts: stagedHosts.map((h) => h.region ?? h.hostId ?? "a host") } : null;
  const refusal = hosts.map((h) => (staleRefusal(statusOf(h)) ? null : (statusOf(h).lastRefusal ?? null))).find((r) => r !== null) ?? null;
  const stale = hosts.map((h) => (staleRefusal(statusOf(h)) ? (statusOf(h).lastRefusal ?? null) : null)).find((r) => r !== null) ?? null;
  const failing = hosts.filter((h) => h.healthz?.status === "failing").length;
  const degraded = hosts.filter((h) => h.healthz?.status === "degraded").length;
  return { generation, activeOn, total: hosts.length, staged, refusal, staleRefusal: stale, failing, degraded, exchange };
}

/** Timeline rows merged without repeats: the API's row id first, the (at, kind, host) triple for rows without one. Newest last. */
export function mergeEvents<T extends { at: string; kind: string; host: string; id?: string }>(current: readonly T[], fresh: readonly T[], keep = 200): T[] {
  const keyOf = (e: T) => e.id ?? `${e.at}|${e.kind}|${e.host}`;
  const seen = new Set(current.map(keyOf));
  const merged = [...current];
  for (const e of fresh) {
    const key = keyOf(e);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  return merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-keep);
}
