/**
 * The customer rail on Inbox: the account, this reply, and the live test.
 * A quiet link on the version opens the render. Nothing here is invented.
 *
 * @example
 * ```tsx
 * <LiveBoard ticket={ticket} runs={runs} arms={arms} onBehind={open} />
 * ```
 */
import { isHostedRun, type AnyRun, type Arms, type Ticket } from "../api";
import { TOOLTIPS, armLabel, money, score, versionBadge } from "../format";
import { Behind } from "./Behind";
import { Experiments } from "./Experiments";

function officeName(host: string): string {
  if (host.includes("lambda")) return "this desk";
  if (host.includes("eu-west") || host.includes("/ec2")) return "the Europe office";
  return host;
}

function thisAnswer(runs: AnyRun[]): { version: string; mix: string; office: string; cost: string; quality: string; start: string } | null {
  const run = [...runs].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (!run) return null;
  if (isHostedRun(run)) {
    const result = run.stream.result;
    if (!result) return null;
    return {
      version: versionBadge(run.catalogue.slot?.tag ?? "support.reply", result.versionId, result.generation),
      mix: armLabel(result.arm),
      office: "AirPrompter’s hosted route",
      cost: money(result.priceMicros / 1_000_000),
      quality: run.feedback?.accepted ? "sent as is" : "—",
      start: "run-step",
    };
  }
  const reply = run.steps.find((s) => s.step === "reply");
  if (!reply) return null;
  return {
    version: versionBadge(reply.tag, reply.versionId, reply.generation),
    mix: armLabel(reply.arm),
    office: officeName(run.host),
    cost: money(reply.costUsd),
    quality: reply.judge ? score(reply.judge) : "—",
    start: run.host.includes("eu-west") || run.host.includes("/ec2") ? "daemon-start" : "lambda-start",
  };
}

export function LiveBoard({ ticket, runs, arms, onBehind }: { ticket: Ticket | null; runs: AnyRun[]; arms: Arms | null; onBehind: (id: string) => void }) {
  const answer = thisAnswer(runs);
  const customer = ticket?.customer ?? null;
  return (
    <div className="live-board">
      <section className="account">
        <div className="pane-title"><h2>Account</h2></div>
        {customer ? (
          <>
            <p className="account-name">{customer.name}</p>
            <p className="muted fine">
              <span className={`chip tier-${customer.tier}`}>{customer.tier}</span>
              {" · "}{customer.seats} seats · customer since {customer.since}
            </p>
            <p className="muted fine">{customer.customerId}</p>
          </>
        ) : (
          <p className="muted fine">{ticket?.customerId ?? "No ticket selected."}</p>
        )}
      </section>
      <section className="this-answer" title={TOOLTIPS.version}>
        <div className="pane-title"><h2>This reply</h2></div>
        {answer ? (
          <>
            <dl className="kv">
              <div><dt>prompt version</dt><dd>{answer.version}</dd></div>
              <div><dt title={TOOLTIPS.arm}>this customer got</dt><dd>{answer.mix}</dd></div>
              <div><dt>answered from</dt><dd>{answer.office}</dd></div>
              <div><dt>cost</dt><dd>{answer.cost}</dd></div>
              <div><dt title={TOOLTIPS.judge}>quality</dt><dd>{answer.quality}</dd></div>
            </dl>
            <p className="behind-row">
              <Behind id="run-step" onOpen={onBehind} title={TOOLTIPS.version}>how this reply is written</Behind>
              {" · "}
              <Behind id={answer.start} onOpen={onBehind}>how this desk starts</Behind>
            </p>
          </>
        ) : (
          <p className="muted fine">No reply on this ticket yet.</p>
        )}
      </section>
      <Experiments arms={arms} />
    </div>
  );
}
