/**
 * The signed-out desk: one card, one button to the hosted UI. Prospects never see this — the owner signs in
 * before the session and the tab stays signed in for the day.
 *
 * @example
 * ```tsx
 * <SignIn onSignIn={() => auth.beginSignIn()} environment="dev" />
 * ```
 */

export function SignIn({ onSignIn, environment, problem }: { onSignIn: () => void; environment: string; problem?: string }) {
  return (
    <main className="signin">
      <div className="signin-card">
        <p className="eyebrow">Zudocs</p>
        <h1>The support desk</h1>
        <p className="lede">Tickets answered by prompts that live in AirPrompter{environment ? ` (${environment})` : ""} — not in this app. Sign in to run one.</p>
        {problem ? <p className="problem">{problem}</p> : null}
        <button className="button" type="button" onClick={onSignIn}>Sign in</button>
        <p className="fine">Zudocs is a fictional company built to demonstrate AirPrompter.</p>
      </div>
    </main>
  );
}
