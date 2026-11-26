import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/** How long the pointer must rest on the handle before it counts as deliberate. */
const HOVER_REVEAL_MS = 220;
/** Grace period for moving between the handle and the panel before a hover reveal closes. */
const HOVER_HIDE_MS = 380;

type Reveal = "hover" | "pinned";

/**
 * On-demand toolbar for a maximized remote view. The desktop owns every pixel; a small corner
 * handle reveals the toolbar as an overlay on a deliberate hover, a click/tap or keyboard focus.
 * The toolbar hides again when the pointer returns to the desktop (hover reveals) or on a press
 * outside it (pinned reveals), and it only listens for keys inside its own elements, so remote
 * shortcuts keep reaching the desktop.
 *
 * @param active whether the view is maximized; outside it there is no handle and no overlay
 * @param held keeps the toolbar open while one of its panels (tools, keyboard, dialog) is open
 * @param restoreFocus moves focus back to the desktop after Escape; false when it cannot
 */
export function useImmersiveChrome({
  active,
  held,
  restoreFocus,
}: {
  active: boolean;
  held: boolean;
  restoreFocus: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const reveal = useRef<Reveal>("hover");
  const handleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Bumped on every reveal/hide so a pending blur check cannot undo a newer decision. */
  const epoch = useRef(0);
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  if (!active && open) setOpen(false);
  const visible = active && open;

  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(
    () => () => {
      clearTimer();
      clearTimeout(blurTimer.current);
      epoch.current += 1;
    },
    [active, clearTimer],
  );

  const inside = useCallback(
    (node: EventTarget | null) =>
      node instanceof Node &&
      (handleRef.current?.contains(node) === true || panelRef.current?.contains(node) === true),
    [],
  );
  const show = useCallback(
    (how: Reveal) => {
      clearTimer();
      epoch.current += 1;
      reveal.current = how;
      setOpen(true);
    },
    [clearTimer],
  );
  const hide = useCallback(() => {
    clearTimer();
    epoch.current += 1;
    setOpen(false);
  }, [clearTimer]);

  // A press anywhere else (the desktop included) dismisses the toolbar without consuming the
  // press, so the same click still reaches the remote machine.
  useEffect(() => {
    if (!visible) return;
    const onPress = (event: globalThis.PointerEvent) => {
      if (!heldRef.current && !inside(event.target)) hide();
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [visible, inside, hide]);

  const hoverEnter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    clearTimer();
    if (visible) return;
    timer.current = setTimeout(() => show("hover"), HOVER_REVEAL_MS);
  };
  const hoverLeave = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    clearTimer();
    if (!visible || reveal.current !== "hover") return;
    timer.current = setTimeout(() => {
      const focused = document.activeElement;
      if (!heldRef.current && !(focused && panelRef.current?.contains(focused))) setOpen(false);
    }, HOVER_HIDE_MS);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !visible || event.defaultPrevented) return;
    event.preventDefault();
    hide();
    if (!restoreFocus()) handleRef.current?.focus();
  };
  const onHandleClick = () => {
    if (visible && reveal.current === "pinned") return hide();
    show("pinned");
  };
  const onHandleFocus = (event: FocusEvent<HTMLButtonElement>) => {
    let keyboard: boolean;
    try {
      keyboard = event.currentTarget.matches(":focus-visible");
    } catch {
      keyboard = false;
    }
    if (keyboard && !visible) show("pinned");
  };
  // Tabbing past the toolbar dismisses a pinned reveal. Judged after the tick so a panel that
  // opens and takes focus (tools sheet, dialog) is already known to hold the toolbar open.
  const onBlur = () => {
    if (reveal.current !== "pinned") return;
    const seen = epoch.current;
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      if (seen !== epoch.current) return;
      const focused = document.activeElement;
      if (heldRef.current || !focused || focused === document.body || inside(focused)) return;
      hide();
    }, 0);
  };

  return {
    visible,
    handle: {
      ref: handleRef,
      onClick: onHandleClick,
      onFocus: onHandleFocus,
      onBlur,
      onKeyDown,
      onPointerEnter: hoverEnter,
      onPointerLeave: hoverLeave,
    },
    panel: {
      ref: panelRef,
      onKeyDown,
      onBlur,
      onPointerEnter: hoverEnter,
      onPointerLeave: hoverLeave,
    },
  };
}
