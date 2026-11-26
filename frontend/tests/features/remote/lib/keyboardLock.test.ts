import { afterEach, expect, it } from "bun:test";
import {
  DEFAULT_CONTROL_HINT,
  keyboardLockApi,
  keyboardLockFailure,
  keyboardLockSuperseded,
  remoteShortcutHint,
  type KeyboardLockStatus,
} from "@/features/remote/lib/keyboardLock";

afterEach(() => {
  Reflect.deleteProperty(navigator, "keyboard");
});

it("finds the Keyboard Lock API only when both lock and unlock exist", () => {
  expect(keyboardLockApi()).toBeNull();
  Object.defineProperty(navigator, "keyboard", {
    configurable: true,
    value: { lock: () => Promise.resolve() },
  });
  expect(keyboardLockApi()).toBeNull();
  Object.defineProperty(navigator, "keyboard", {
    configurable: true,
    value: { lock: () => Promise.resolve(), unlock: () => {} },
  });
  expect(keyboardLockApi()).not.toBeNull();
});
it("separates refusals from other failures and recognises a superseded lock", () => {
  expect(keyboardLockFailure(new DOMException("", "NotAllowedError"))).toBe("denied");
  expect(keyboardLockFailure(new DOMException("", "SecurityError"))).toBe("denied");
  expect(keyboardLockFailure(new DOMException("", "InvalidStateError"))).toBe("failed");
  expect(keyboardLockFailure("boom")).toBe("failed");
  expect(keyboardLockSuperseded(new DOMException("", "AbortError"))).toBe(true);
  expect(keyboardLockSuperseded(new DOMException("", "NotAllowedError"))).toBe(false);
});
const hint = (overrides: Partial<Parameters<typeof remoteShortcutHint>[0]>) =>
  remoteShortcutHint({
    controlling: true,
    canControl: true,
    nativeFullscreen: true,
    maximized: true,
    lock: "locked",
    ...overrides,
  });
it("tells a controlling fullscreen user what actually happens to browser shortcuts", () => {
  expect(hint({})).toContain("Click the desktop");
  expect(hint({})).toContain("Hold Esc");
  const messages = (["locking", "denied", "unsupported", "failed"] as KeyboardLockStatus[]).map(
    (lock) => hint({ lock }),
  );
  expect(new Set(messages).size).toBe(4);
  expect(hint({ lock: "denied" })).toContain("still act on this tab");
  expect(hint({ lock: "unsupported" })).toContain("Chrome and Edge");
  expect(hint({ lock: "idle" })).toBe(DEFAULT_CONTROL_HINT);
});
it("keeps the plain typing hint outside native fullscreen and never claims capture there", () => {
  expect(hint({ nativeFullscreen: false, maximized: true, lock: "idle" })).toBe(
    DEFAULT_CONTROL_HINT,
  );
  expect(hint({ nativeFullscreen: false, maximized: false, lock: "idle" })).toBe(
    DEFAULT_CONTROL_HINT,
  );
});
it("says nothing is sent while only viewing a maximized desktop, and stays quiet otherwise", () => {
  expect(hint({ controlling: false, lock: "idle" })).toBe(
    "Viewing only. Take control to send keys to this desktop.",
  );
  expect(hint({ controlling: false, canControl: false, lock: "idle" })).toBe("");
  expect(hint({ controlling: false, maximized: false, lock: "idle" })).toBe("");
});
