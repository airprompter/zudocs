/**
 * A closed disclosure. The summary is the only thing on the page until it is opened.
 *
 * @example
 * ```tsx
 * <Fold title="Details">…</Fold>
 * ```
 */
export function Fold({ title, children, open }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary>{title}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
