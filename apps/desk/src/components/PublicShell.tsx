/**
 * The signed-out desk: Zudocs Support. Sign in to the inbox. A quiet link
 * opens how a reply is written. No API client.
 *
 * @example
 * ```tsx
 * <PublicShell environment="dev" agentId="agent_…" onSignIn={() => auth.beginSignIn()} />
 * ```
 */
import { useState } from "react";
import { CodeDrawer } from "./CodeDrawer";
import { Behind } from "./Behind";
import { IntegrationFlow } from "./IntegrationFlow";
import { AIRGAP_START, DAEMON_START, LAMBDA_START, POLICY_LINE, RUN_STEP, TELEMETRY_DAEMON } from "../snippets";

const SNIPPETS = [RUN_STEP, LAMBDA_START, DAEMON_START, POLICY_LINE, TELEMETRY_DAEMON, AIRGAP_START];

export function PublicShell({ environment, agentId, onSignIn, problem }: { environment: string; agentId: string; onSignIn: () => void; problem?: string }) {
  const [sheet, setSheet] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const openBehind = (id: string) => {
    setFocus(id);
    setSheet(true);
  };
  return (
    <div className={`desk route-architecture${sheet ? " sheet-open" : ""}`}>
      <header className="top">
        <a className="brand" href="/">Zu<span>docs</span> <em>support</em></a>
        <div className="who">
          <button type="button" className="button" onClick={onSignIn}>Sign in</button>
        </div>
      </header>
      <div className="columns">
        <main className="centre support-welcome">
          {problem ? <p className="problem">{problem}</p> : null}
          <p className="eyebrow">Zudocs support · powered by AirPrompter</p>
          <h1>From a prompt update to a customer reply.</h1>
          <p className="lede">Zudocs customers ask about their docs. AirPrompter supplies the versioned prompts; the Zudocs desk uses them to triage, answer and check each ticket.</p>
          <section className="welcome-flow" aria-labelledby="welcome-flow-title">
            <h2 id="welcome-flow-title">How the two systems work together</h2>
            <IntegrationFlow label="AirPrompter to Zudocs support" steps={[
              { title: "AirPrompter releases", detail: "A signed version carries the prompts, checks and any A/B split." },
              { title: "Zudocs loads it", detail: "The Agent SDK gives this desk the release its host has applied." },
              { title: "A ticket gets a reply", detail: "The desk shows the answer, its prompt version and the results of its checks." },
            ]} />
          </section>
          <p className="fine muted">
            <Behind id="run-step" onOpen={openBehind}>how a reply is written</Behind>
            {" · "}
            <Behind id="lambda-start" onOpen={openBehind}>how this desk starts</Behind>
            {environment || agentId ? ` · ${environment} · ${agentId}` : ""}
          </p>
        </main>
        {sheet ? <CodeDrawer snippets={SNIPPETS} focus={focus} onClose={() => setSheet(false)} /> : null}
      </div>
    </div>
  );
}
