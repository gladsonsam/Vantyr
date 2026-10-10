import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, X } from "lucide-react";

export function RemoteToolGroup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="remote-tool-group">
    <button type="button" className="remote-tool-group-toggle" aria-expanded={open} aria-controls={id} onClick={event => { event.currentTarget.focus(); setOpen(value => !value); }}>
      <span>{title}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div id={id} className="remote-tool-group-content">{children}</div>}
  </section>;
}

/** Stays inside the viewer's fullscreen tree. Closed sheets leave no controls in the DOM. */
export function RemoteToolsSheet({ children, onClose, triggerRef }: { children: ReactNode; onClose: () => void; triggerRef: RefObject<HTMLButtonElement | null> }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  // The Escape handler below reads this between renders; mirror the latest
  // callback here so it never closes over a stale render snapshot.
  useEffect(() => {
    closeRef.current = onClose;
  });
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Inert siblings at each ancestor, including the rest of the page. Preserve
    // preexisting values so nested dialogs and unmounts recover cleanly.
    const disabled: Array<{ element: HTMLElement; inert: boolean }> = [];
    let node: HTMLElement = dialog.parentElement!;
    while (node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          disabled.push({element:sibling,inert:sibling.inert}); sibling.inert = true;
        }
      }
      node = node.parentElement;
      if (node === document.body) break;
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trigger = triggerRef.current;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex='0']")];
    (controls()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
      } else if (event.key === "Tab") {
        const elements = controls(), first = elements[0] ?? dialog, last = elements[elements.length - 1] ?? dialog;
        if (!dialog.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) (controls()[0] ?? dialog).focus(); };
    document.addEventListener("keydown", onKey); document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey); document.removeEventListener("focusin", onFocus);
      disabled.forEach(({element,inert}) => { element.inert = inert; });
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [triggerRef]);
  return <div className="remote-tools-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="remote-tools-sheet">
      <header><div><span className="remote-tools-eyebrow">REMOTE DESKTOP</span><h2 id={titleId}>More tools</h2></div><button type="button" aria-label="Close remote tools" onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
      <div className="remote-tools-scroll">{children}</div>
    </div>
  </div>;
}
