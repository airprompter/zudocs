/** Compare two real answers to one ticket on the same host and route, across releases. */
import { isHostedRun, type AnyRun, type Run, type Step } from "../api";
import { clock } from "../format";
import { ReplyText } from "./ReplyText";

export interface ReplyEvidence { run: Run; reply: Step }
export interface ReplyPair { before: ReplyEvidence; after: ReplyEvidence }

export function replyPair(runs: AnyRun[]): ReplyPair | null {
  const replies: ReplyEvidence[] = runs.filter((run): run is Run => !isHostedRun(run) && run.kind === "run")
    .map((run) => ({ run, reply: run.steps.find((step) => step.step === "reply")! }))
    .filter((item) => item.reply?.output && !item.reply.error)
    .sort((a, b) => b.run.at.localeCompare(a.run.at));
  for (const after of replies) {
    const before = replies.find((item) => item.run.at < after.run.at && item.run.ticketId === after.run.ticketId && item.run.host === after.run.host &&
      (item.run.route ?? "bedrock") === (after.run.route ?? "bedrock") && item.run.generation !== after.run.generation);
    if (before) return { before, after };
  }
  return null;
}

function Answer({ label, evidence }: { label: string; evidence: ReplyEvidence }) {
  const { run, reply } = evidence;
  const passed = reply.checks.filter((check) => check.verdict === "pass").length;
  return <div className="reply-comparison-side">
    <p className="eyebrow">{label}</p>
    <h3>Release #{run.generation} · {reply.versionId ?? "version unreported"}</h3>
    <p className="muted fine">{clock(run.at)} · {passed}/{reply.checks.length} checks passed</p>
    <ReplyText text={reply.output ?? ""} compact />
  </div>;
}

export function ReplyComparison({ runs }: { runs: AnyRun[] }) {
  const pair = replyPair(runs);
  if (!pair) return null;
  const versionChanged = pair.before.reply.versionId !== pair.after.reply.versionId;
  return <section className="reply-comparison" aria-label="Reply before and after release change">
    <div className="reply-comparison-head"><div><p className="eyebrow">Same ticket · same host · same route</p><h2>What changed after the release</h2></div><span className="muted fine">{pair.after.run.host}</span></div>
    <div className="reply-comparison-grid"><Answer label="Before" evidence={pair.before} /><Answer label="After" evidence={pair.after} /></div>
    <p className="muted fine">{versionChanged ? `The reply prompt version changed from ${pair.before.reply.versionId ?? "unreported"} to ${pair.after.reply.versionId ?? "unreported"}.` : "The reply prompt version is the same in both records; differences in wording may be model variation."}</p>
  </section>;
}
