// Browser keyboard / mouse events → agent remote-input commands.

/** Browser KeyboardEvent.key values that map to SpecialKey enum variants. */
const SPECIAL_KEY_MAP: Record<string, string> = {
  Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape",
  Delete: "delete", Insert: "insert", " ": "space",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright",
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
  CapsLock: "capslock",
};

/** Keys that are modifier keys — sent as KeyDown/KeyUp not KeyPress. */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/** Returns true for printable single characters (not modifiers, not specials). */
function isPrintable(key: string): boolean {
  return Array.from(key).length === 1 && !MODIFIER_KEYS.has(key);
}

export type KeyDownAction =
  /** Hold a modifier (`KeyDown`, released later with `KeyUp`). */
  | { kind: "modifier"; key: string }
  /** A named key (`KeyPress`). */
  | { kind: "special"; key: string }
  /** A character typed with Ctrl/Alt/Meta held — sent as a physical key so the OS combo fires. */
  | { kind: "char"; char: string }
  /** Plain text (`TypeText`). */
  | { kind: "text"; text: string };

/** What a keydown should send to the agent, or null when it maps to nothing. */
export function keyDownAction(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): KeyDownAction | null {
  if (MODIFIER_KEYS.has(e.key)) return { kind: "modifier", key: e.key.toLowerCase() };
  const special = SPECIAL_KEY_MAP[e.key];
  if (special) return { kind: "special", key: special };
  if (isPrintable(e.key)) {
    return e.ctrlKey || e.altKey || e.metaKey ? { kind: "char", char: e.key } : { kind: "text", text: e.key };
  }
  return null;
}

/** Pointer button → "left" | "middle" | "right". */
export function buttonName(btn: number): "left" | "middle" | "right" {
  return btn === 2 ? "right" : btn === 1 ? "middle" : "left";
}

/**
 * Converts wheel deltas to scroll notches (1 notch ≈ one wheel click), carrying fractions
 * between events so small trackpad deltas add up instead of being dropped. At most 10 notches
 * per axis per event.
 */
export function createWheelAccumulator() {
  let scrollX = 0, scrollY = 0;
  return (e: { deltaX: number; deltaY: number; deltaMode: number }): { dx: number; dy: number } | null => {
    const factor = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 100;
    scrollY += e.deltaY * factor; scrollX += e.deltaX * factor;
    const cdx = Math.max(-10, Math.min(10, Math.trunc(scrollX)));
    const cdy = Math.max(-10, Math.min(10, Math.trunc(scrollY)));
    if (cdx === 0 && cdy === 0) return null;
    scrollX -= cdx; scrollY -= cdy;
    return { dx: cdx, dy: cdy };
  };
}
