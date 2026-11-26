import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "@vantyr/ui/components/sidebar";

let host: HTMLDivElement, root: Root;
function Probe() { const { open } = useSidebar(); return <span data-testid="state">{open ? "open" : "closed"}</span>; }
const state = () => host.querySelector("[data-testid=state]")!.textContent;
function chord(init: { prevent?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });
  if (init.prevent) document.body.addEventListener("keydown", e => e.preventDefault(), { once: true });
  act(() => { document.body.dispatchEvent(event); });
}
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<SidebarProvider><Probe /></SidebarProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("toggles on Ctrl+B", () => { chord(); expect(state()).toBe("closed"); });
it("leaves Ctrl+B to a surface that already handled it, such as the remote desktop", () => { chord({ prevent: true }); expect(state()).toBe("open"); });
it("ignores Ctrl+B while an element is fullscreen", () => {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.body });
  try { chord(); } finally { Reflect.deleteProperty(document, "fullscreenElement"); }
  expect(state()).toBe("open");
});
