// Keyboard Lock API (navigator.keyboard.lock): while a page is in JavaScript-initiated fullscreen,
// the browser hands over Ctrl+W, Ctrl+T, Ctrl+N, Alt+Tab-class keys instead of acting on them.
// Chromium-only today (Chrome/Edge); Firefox and Safari have no Keyboard Lock. Chrome 130+ asks the
// user for permission, needs transient user activation, and always keeps a long Esc press as the
// browser's own way out of the lock.
//
// Chrome's `requestFullscreen({ keyboardLock: "browser" })` option is deliberately not used: it
// cannot be feature-detected and gives no signal about whether the lock took effect, while
// `keyboard.lock()` resolves or rejects so the UI can say what actually happened.

export type KeyboardLockStatus = "idle" | "locking" | "locked" | "unsupported" | "denied" | "failed";

export interface KeyboardLockApi {
  lock: (keyCodes?: string[]) => Promise<void>;
  unlock: () => void;
}

/** The browser's Keyboard Lock, or null where the API does not exist (Firefox, Safari, insecure origins). */
export function keyboardLockApi(): KeyboardLockApi | null {
  if (typeof navigator === "undefined") return null;
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLockApi> }).keyboard;
  if (!keyboard || typeof keyboard.lock !== "function" || typeof keyboard.unlock !== "function") return null;
  return { lock: codes => keyboard.lock!(codes), unlock: () => keyboard.unlock!() };
}

/** Permission refused (or no user gesture) versus any other failure to start the lock. */
export function keyboardLockFailure(error: unknown): "denied" | "failed" {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed";
}

/** A lock superseded by a newer lock() call rejects with AbortError; it is not a failure. */
export function keyboardLockSuperseded(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

export const DEFAULT_CONTROL_HINT = "Click the screen to type · Paste with Ctrl/⌘ V";

/**
 * The one-line keyboard note under the session mode. While controlling in native fullscreen it
 * says whether browser shortcuts reach the device; while only viewing in a maximized view it says
 * nothing is being sent, so a fullscreen user is never left guessing.
 */
export function remoteShortcutHint({ controlling, canControl, nativeFullscreen, maximized, lock }: {
  controlling: boolean; canControl: boolean; nativeFullscreen: boolean; maximized: boolean; lock: KeyboardLockStatus;
}): string {
  if (!controlling) return maximized && canControl ? "Viewing only. Take control to send keys to this desktop." : "";
  if (!nativeFullscreen) return DEFAULT_CONTROL_HINT;
  switch (lock) {
    case "locked": return "Browser shortcuts like Ctrl+W go to this desktop. Hold Esc to leave fullscreen.";
    case "locking": return "Allow keyboard capture if your browser asks, so Ctrl+W and Ctrl+T reach this desktop.";
    case "denied": return "Your browser blocked shortcut capture, so Ctrl+W and Ctrl+T still act on this tab. Allow keyboard lock for this site, then re-enter fullscreen.";
    case "unsupported": return "This browser can’t send Ctrl+W or Ctrl+T to the desktop in fullscreen. Chrome and Edge can.";
    case "failed": return "Couldn’t capture browser shortcuts. Click the screen to try again.";
    default: return DEFAULT_CONTROL_HINT;
  }
}
