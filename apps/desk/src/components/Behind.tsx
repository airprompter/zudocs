/**
 * A quiet control on a live fact. Opens the source slice that produced it.
 *
 * @example
 * ```tsx
 * <Behind id="run-step" onOpen={open}>how this render starts</Behind>
 * ```
 */
export function Behind({ id, onOpen, children, title }: { id: string; onOpen: (id: string) => void; children: string; title?: string }) {
  return <button type="button" className="link behind" title={title} onClick={() => onOpen(id)}>{children}</button>;
}
