/**
 * Per-arm results from the desk's own records (beat 4): every reply and triage step on every run today, grouped by
 * slot, prompt version and arm — runs, the hosts that served them, the judge's mean score, the mean cost at list
 * price, the checks, and the feedback filed (thumbs, accepted, edited) — plus the stickiness table: per customer,
 * the arm each host landed them on, and whether every host agreed. Nothing here is a model of the experiment: it is
 * a fold over what the SDK rendered (`arm`, `versionId`) and what the desk observed, so a prospect can compare arms
 * on the desk and then see AirPrompter's own rollout page compute the same split from the windows the hosts uploaded.
 *
 * Stickiness is compared on the weights in force: one row per (customer, slot, generation). A dial is a new
 * generation with new weights, and a customer whose bucket moved with them landed on the control before and the
 * candidate after — by design, not a disagreement. Two hosts disagree only when they served the same customer
 * different arms under the same release; a host that lags a generation (eu-west, until its approval) is simply not
 * yet comparable, and the panel says so.
 *
 * @example
 * ```ts
 * const { arms, stickiness } = foldArms(runs, feedback);
 * arms.find((a) => a.tag === "support.reply" && a.arm === "candidate")?.judgeMean;   // 0.83
 * stickiness.every((s) => s.consistent);                                             // the same customer, the same arm, every host, under the same release
 * ```
 */

export interface ArmSummary {
  tag: string;
  arm: string;
  versionId: string;
  model: string;
  runs: number;
  hosts: Record<string, number>;
  judgeMean: number | null;
  judged: number;
  costMeanUsd: number | null;
  costed: number;
  checksPassed: number;
  checksFailed: number;
  latencyMeanMs: number | null;
  errors: number;
  feedback: { up: number; down: number; accepted: number; edited: number };
}

export interface Stickiness {
  customerId: string;
  tag: string;
  /** The release the runs were served under — the weights in force; null when a run recorded none. */
  generation: number | null;
  /** host → the one arm seen there under this generation; a host that served two arms for one customer reads "control+candidate". */
  arms: Record<string, string>;
  consistent: boolean;
}

type RunRow = Record<string, unknown> & { runId: string; ticketId: string };
type FeedbackRow = { runId: string; signals: Record<string, unknown>; filed: boolean };

interface StepLike { step: string; tag: string; versionId: string | null; arm: string | null; model: string | null; generation?: number | null; observation?: { latencyMs?: number } | null; checks?: Array<{ verdict: string }>; costUsd?: number | null; judge?: { score: number | null } | null; error?: unknown | null }

const key = (s: { tag: string; arm: string; versionId: string; model: string }) => `${s.tag}|${s.arm}|${s.versionId}|${s.model}`;

export function foldArms(runs: RunRow[], feedback: FeedbackRow[]): { arms: ArmSummary[]; stickiness: Stickiness[] } {
  const byRun = new Map<string, FeedbackRow[]>();
  for (const f of feedback) {
    if (!f.filed) continue;
    const list = byRun.get(f.runId) ?? [];
    list.push(f);
    byRun.set(f.runId, list);
  }
  const arms = new Map<string, ArmSummary & { judgeSum: number; costSum: number; latencySum: number; latencyN: number }>();
  const seen = new Map<string, { customerId: string; tag: string; generation: number | null; perHost: Map<string, Set<string>> }>();
  for (const run of runs) {
    if (run.kind === "hosted") continue;
    const steps = Array.isArray(run.steps) ? (run.steps as StepLike[]) : [];
    const host = typeof run.host === "string" ? run.host : "unknown";
    const customerId = typeof run.customerId === "string" ? run.customerId : "";
    for (const step of steps) {
      if (!step.versionId || !step.arm || !step.model) continue;
      const k = key({ tag: step.tag, arm: step.arm, versionId: step.versionId, model: step.model });
      const entry = arms.get(k) ?? { tag: step.tag, arm: step.arm, versionId: step.versionId, model: step.model, runs: 0, hosts: {}, judgeMean: null, judged: 0, costMeanUsd: null, costed: 0, checksPassed: 0, checksFailed: 0, latencyMeanMs: null, errors: 0, feedback: { up: 0, down: 0, accepted: 0, edited: 0 }, judgeSum: 0, costSum: 0, latencySum: 0, latencyN: 0 };
      entry.runs += 1;
      entry.hosts[host] = (entry.hosts[host] ?? 0) + 1;
      if (step.judge && typeof step.judge.score === "number") { entry.judged += 1; entry.judgeSum += step.judge.score; }
      if (typeof step.costUsd === "number") { entry.costed += 1; entry.costSum += step.costUsd; }
      if (typeof step.observation?.latencyMs === "number") { entry.latencyN += 1; entry.latencySum += step.observation.latencyMs; }
      for (const c of step.checks ?? []) c.verdict === "pass" ? (entry.checksPassed += 1) : (entry.checksFailed += 1);
      if (step.error) entry.errors += 1;
      // Feedback is filed against the reply step (the hand-off on an escalation); it counts on the arm that served that step.
      if (step.step === "reply" || step.step === "handoff") {
        for (const f of byRun.get(run.runId) ?? []) {
          const s = f.signals;
          if (s.thumbs === "up") entry.feedback.up += 1;
          if (s.thumbs === "down") entry.feedback.down += 1;
          if (s.accepted === true) entry.feedback.accepted += 1;
          if (s.edited === true) entry.feedback.edited += 1;
        }
      }
      arms.set(k, entry);
      if (customerId && step.arm !== "none") {
        const generation = typeof step.generation === "number" ? step.generation : null;
        const k = `${customerId}|${step.tag}|${generation ?? "?"}`;
        const entry = seen.get(k) ?? { customerId, tag: step.tag, generation, perHost: new Map<string, Set<string>>() };
        const set = entry.perHost.get(host) ?? new Set<string>();
        set.add(step.arm);
        entry.perHost.set(host, set);
        seen.set(k, entry);
      }
    }
  }
  const summaries: ArmSummary[] = [...arms.values()].map(({ judgeSum, costSum, latencySum, latencyN, ...rest }) => ({
    ...rest,
    judgeMean: rest.judged ? Math.round((judgeSum / rest.judged) * 1000) / 1000 : null,
    costMeanUsd: rest.costed ? costSum / rest.costed : null,
    latencyMeanMs: latencyN ? Math.round(latencySum / latencyN) : null,
  })).sort((a, b) => a.tag.localeCompare(b.tag) || a.arm.localeCompare(b.arm) || a.versionId.localeCompare(b.versionId));
  const stickiness: Stickiness[] = [...seen.values()].map(({ customerId, tag, generation, perHost }) => {
    const armsByHost = Object.fromEntries([...perHost.entries()].map(([host, set]) => [host, [...set].sort().join("+")]));
    const distinct = new Set(Object.values(armsByHost));
    return { customerId, tag, generation, arms: armsByHost, consistent: distinct.size === 1 && ![...distinct][0]!.includes("+") };
  }).sort((a, b) => a.tag.localeCompare(b.tag) || a.customerId.localeCompare(b.customerId) || (a.generation ?? -1) - (b.generation ?? -1));
  return { arms: summaries, stickiness };
}
