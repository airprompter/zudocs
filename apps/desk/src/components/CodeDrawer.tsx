/**
 * The code slide-out. Each block is a full slice of a source file, with marks on the calls
 * the caption names. Copy writes that whole slice. A focus id scrolls that block into view.
 *
 * @example
 * ```tsx
 * <CodeDrawer snippets={[RUN_STEP, LAMBDA_START, CLIENT_RUN]} focus="run-step" onClose={() => setOpen(false)} />
 * ```
 */
import { useEffect, useState } from "react";
import { splitMarks } from "../excerpt";
import type { Snippet } from "../snippets";

export function CodeDrawer({ snippets, focus, onClose }: { snippets: readonly Snippet[]; focus?: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!focus) return;
    document.querySelector(`[data-snippet="${focus}"]`)?.scrollIntoView({ block: "start" });
  }, [focus]);
  return (
    <aside className="code-drawer" aria-label="Code">
      <div className="pane-title">
        <h2>Code</h2>
        <button type="button" className="link sheet-close" onClick={onClose}>Close</button>
      </div>
      <p className="fine legend">
        <mark className="mark-write">What you write</mark> is the SDK call. <mark className="mark-host">What this host adds</mark> is this deployment. The block is the whole call.
      </p>
      {snippets.map((snippet) => <SnippetBlock key={snippet.id} snippet={snippet} focused={snippet.id === focus} />)}
    </aside>
  );
}

function SnippetBlock({ snippet, focused }: { snippet: Snippet; focused: boolean }) {
  const [copied, setCopied] = useState(false);
  const parts = splitMarks(snippet.text, snippet.marks);
  const copy = () => {
    void navigator.clipboard.writeText(snippet.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => setCopied(false));
  };
  return (
    <section className={`snippet${focused ? " snippet-focus" : ""}`} data-snippet={snippet.id}>
      <p className="eyebrow">{snippet.caption}</p>
      <p className="fine snippet-file"><code>{snippet.file}</code> <button type="button" className="link" onClick={copy}>{copied ? "Copied" : "Copy"}</button></p>
      <pre className="excerpt">{parts.map((part, index) => part.kind ? <mark key={index} className={`mark-${part.kind}`}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</pre>
    </section>
  );
}
