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
import { AIRGAP_START, DAEMON_CONNECT, DAEMON_GUARD, DAEMON_START, LAMBDA_START, POLICY_LINE, RUN_STEP } from "../snippets";

const SNIPPETS = [RUN_STEP, LAMBDA_START, DAEMON_CONNECT, DAEMON_START, DAEMON_GUARD, POLICY_LINE, AIRGAP_START];

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
          <p className="eyebrow">Documentation, hosted</p>
          <h1>Support that answers from your docs.</h1>
          <p className="lede">Zudocs is Publish, Search and Support. Team and Business customers write in about PDF export, search, SSO and billing. Every ticket is triaged and answered from the pages they already host — the prompts live in AirPrompter, not in this app.</p>
          <p className="actions"><button type="button" className="button" onClick={onSignIn}>Sign in to the inbox</button></p>
          <p className="fine muted">
            <Behind id="run-step" onOpen={openBehind}>how a reply is written</Behind>
            {" · "}
            <Behind id="lambda-start" onOpen={openBehind}>how this desk starts</Behind>
            {environment || agentId ? ` · ${environment} · ${agentId}` : ""}
          </p>
        </main>
        <CodeDrawer snippets={SNIPPETS} focus={focus} onClose={() => setSheet(false)} />
      </div>
    </div>
  );
}
