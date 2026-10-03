import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScreenTab } from "./ScreenTab";

vi.mock("../../demo/mode", () => ({ isDemoMode: true }));
vi.mock("../../demo/fakeScreen", () => ({ DemoScreen: () => <div>Demo screen</div> }));
vi.mock("../../lib/api", () => ({ mjpegStreamUrl: () => "", notifyMjpegViewerLeft: vi.fn(), apiUrl: (path: string) => path }));
let host: HTMLDivElement, root: Root;
const send = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); send.mockReset();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, "clipboard"); vi.unstubAllGlobals(); });
async function render(active = true, online = true) {
  await act(async () => root.render(<ScreenTab agentId="device" embedded streamActive={active} online={online} sendWsMessage={send} />));
}
async function takeControl() {
  await render();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Take control"))!;
  await act(async () => button.click());
  return host.querySelector<HTMLElement>('[role="application"]')!;
}
function key(overlay: HTMLElement, value: string, ctrlKey = false) {
  act(() => overlay.dispatchEvent(new KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true, cancelable: true })));
}
it("releases held modifiers on window blur and does not send duplicate keydown or keyup", async () => {
  const overlay = await takeControl();
  key(overlay, "Control"); key(overlay, "Control");
  expect(send.mock.calls.map(c => c[0].cmd)).toEqual([{ type: "KeyDown", key: "control" }]);
  act(() => window.dispatchEvent(new Event("blur")));
  act(() => overlay.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", bubbles: true })));
  expect(send.mock.calls.map(c => c[0].cmd)).toEqual([{ type: "KeyDown", key: "control" }, { type: "KeyUp", key: "control" }]);
});
it("releases inputs when the screen tab is hidden and discards a delayed clipboard read", async () => {
  let resolve!: (text: string) => void;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => new Promise<string>(r => { resolve = r; }) } });
  const overlay = await takeControl(); key(overlay, "Control"); key(overlay, "v", true);
  await render(false);
  await act(async () => resolve("must not be pasted after leaving control"));
  expect(send.mock.calls.map(c => c[0].cmd)).toEqual([{ type: "KeyDown", key: "control" }, { type: "KeyUp", key: "control" }]);
});
it("releases control on device disconnect and disables reacquisition while offline", async () => {
  const overlay = await takeControl(); key(overlay, "Shift");
  await render(true, false);
  expect(host.querySelector('[role="application"]')).toBeNull();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Take control"))!;
  expect(button.disabled).toBe(true);
  expect(send.mock.calls.map(c => c[0].cmd)).toEqual([{ type: "KeyDown", key: "shift" }, { type: "KeyUp", key: "shift" }]);
});
