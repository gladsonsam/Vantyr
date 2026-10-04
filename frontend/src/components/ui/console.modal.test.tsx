// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Modal } from "./console";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); expect(document.body.style.overflow).toBe(""); });

it("contains keyboard focus, announces its title, dismisses with Escape and restores prior focus", () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const dismiss = vi.fn();
  try {
    act(() => root.render(<Modal visible header="Replace device" onDismiss={dismiss} footer={<button>Cancel</button>}><input aria-label="Device name" /></Modal>));
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!;
    const buttons = host.querySelectorAll("button");
    const last = buttons[buttons.length - 1];
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Replace device");
    expect(document.activeElement).toBe(close);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(close);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dismiss).toHaveBeenCalledOnce();
    act(() => root.render(<Modal visible={false} />));
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  } finally { trigger.remove(); }
});

it("only dismisses the topmost dialog when two are open", () => {
  const outer = vi.fn(), inner = vi.fn();
  act(() => root.render(<><Modal visible header="Device actions" onDismiss={outer}/><Modal visible header="Confirm removal" onDismiss={inner}/></>));
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(inner).toHaveBeenCalledOnce();
  expect(outer).not.toHaveBeenCalled();
});
