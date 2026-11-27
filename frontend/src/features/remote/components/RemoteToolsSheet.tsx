import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, X } from "lucide-react";

export function RemoteToolGroup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="remote-tool-group">
      <button
        type="button"
        className="remote-tool-group-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen((value) => !value);
        }}
      >
        <span>{title}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="remote-tool-group-content">
          {children}
        </div>
      )}
    </section>
  );
}

const GAP = 8;
const PANEL_WIDTH = 360;

type Placement = { left: number; width: number; top?: number; bottom?: number; maxHeight: number };

/** Opens above the trigger when it sits in the lower half (the viewer's toolbar is at the bottom). */
function placeNear(trigger: HTMLElement | null): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(PANEL_WIDTH, vw - GAP * 2);
  if (!trigger) return { left: (vw - width) / 2, width, bottom: GAP, maxHeight: vh - GAP * 2 };
  const r = trigger.getBoundingClientRect();
  const left = Math.min(Math.max(GAP, r.right - width), vw - width - GAP);
  const above = r.top > vh / 2;
  return above
    ? { left, width, bottom: vh - r.top + GAP, maxHeight: Math.max(160, r.top - GAP * 2) }
    : { left, width, top: r.bottom + GAP, maxHeight: Math.max(160, vh - r.bottom - GAP * 2) };
}

/**
 * A popover that opens from the button that asked for it. It stays inside the viewer's fullscreen
 * tree, closes on Escape or an outside click, and returns focus to the trigger.
 */
export function RemoteToolsSheet({
  children,
  onClose,
  triggerRef,
}: {
  children: ReactNode;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const [placement, setPlacement] = useState<Placement | null>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    setPlacement(placeNear(triggerRef.current));
  }, [triggerRef]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.show === "function") dialog.show();
    else dialog.setAttribute("open", "");
    const trigger = triggerRef.current;
    const reposition = () => setPlacement(placeNear(trigger));
    window.addEventListener("resize", reposition);
    const controls = () => [
      ...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex='0']",
      ),
    ];
    (controls()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      if (typeof dialog.close === "function") dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [triggerRef]);
  return (
    <div
      className="remote-tools-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <dialog
        ref={dialogRef}
        onCancel={(event) => {
          event.preventDefault();
          closeRef.current();
        }}
        aria-labelledby={titleId}
        tabIndex={-1}
        className="remote-tools-sheet"
        style={
          placement
            ? {
                left: placement.left,
                width: placement.width,
                top: placement.top,
                bottom: placement.bottom,
                maxHeight: placement.maxHeight,
              }
            : { visibility: "hidden" }
        }
      >
        <header>
          <div>
            <h2 id={titleId}>Desktop tools</h2>
          </div>
          <button type="button" aria-label="Close remote tools" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="remote-tools-scroll">{children}</div>
      </dialog>
    </div>
  );
}
