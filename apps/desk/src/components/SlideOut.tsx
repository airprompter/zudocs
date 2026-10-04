/**
 * A modal side panel with native focus containment, Escape dismissal and focus return.
 * @example
 * <SlideOut title="Saved reply" onClose={close}>…</SlideOut>
 */
import { useEffect, useId, useRef, type ReactNode } from "react";

export function SlideOut({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`slide-out${wide ? " slide-wide" : ""}`} aria-labelledby={id}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left) onClose(); }}>
    <header className="slide-head"><h2 id={id}>{title}</h2><button type="button" className="chip-button" onClick={onClose} aria-label={`Close ${title}`}>Close</button></header>
    <div className="slide-body">{children}</div>
  </dialog>;
}
