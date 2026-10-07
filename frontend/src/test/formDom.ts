import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** DOM helpers for tests that drive react-hook-form dialogs (no testing-library in this repo). */
const roots: Root[] = [];

export async function mountForm(node: ReactNode): Promise<void> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
}

export function unmountForms(): void {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
}

/** Set an input's value the way a user typing would (works with React's controlled inputs). */
export async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function byLabel(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.trim() === text);
  if (!label) throw new Error(`no label "${text}"`);
  const target = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector("input");
  if (!target) throw new Error(`label "${text}" has no control`);
  return target as HTMLInputElement;
}

export function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button as HTMLButtonElement;
}

export function fieldErrors(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="field-error"]')).map((e) => e.textContent ?? "");
}
