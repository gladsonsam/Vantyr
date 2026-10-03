import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScreenTab } from "./ScreenTab";

vi.mock("../../demo/mode", () => ({ isDemoMode: true }));
vi.mock("../../demo/fakeScreen", () => ({ DemoScreen: () => <div>Demo screen</div> }));
vi.mock("../../lib/api", () => ({ mjpegStreamUrl: () => "/mjpeg", notifyMjpegViewerLeft: vi.fn(), apiUrl: (path: string) => path }));
let host: HTMLDivElement, root: Root;
const send = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); send.mockReset();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {configurable: true, value: vi.fn()});
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, "clipboard"); vi.unstubAllGlobals(); });
async function render(active = true, online = true) {
  await act(async () => root.render(<ScreenTab agentId="device" embedded streamActive={active} online={online} sendWsMessage={send} dashboardRole="operator" agentInfo={{capabilities: {remote_input: "supported", screen_capture: "supported"}}} />));
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

function imageGeometry() {
  const img = host.querySelector<HTMLImageElement>("img")!;
  Object.defineProperty(img, "naturalWidth", {configurable: true, value: 1280});
  Object.defineProperty(img, "naturalHeight", {configurable: true, value: 720});
  img.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({})});
  return img;
}
function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1) {
  act(() => { const event = new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerType: {value: "touch"}, pointerId: {value: id}, isPrimary: {value: true}}); target.dispatchEvent(event); });
}
function select(label: string, value: string) { act(() => { const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new Event("change", {bubbles: true})); }); }
async function click(label: string) { await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === label)!.click()); }
function text(value: string) { act(() => { const input = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", {bubbles: true})); }); }
const commands = () => send.mock.calls.map(call => call[0].cmd);
it("direct touch rejects letterbox taps and clicks encoded screen coordinates", async () => {
  const overlay = await takeControl(); imageGeometry();
  pointer(overlay, "pointerdown", 200, 20); pointer(overlay, "pointerup", 200, 20); expect(send).not.toHaveBeenCalled();
  pointer(overlay, "pointerdown", 200, 200); pointer(overlay, "pointerup", 200, 200);
  expect(commands()).toEqual([{type: "MouseDown", x: 640, y: 360, button: "left"}, {type: "MouseUp", x: 640, y: 360, button: "left"}]);
});
it("trackpad moves relatively without clicking a swipe, then right-clicks at its cursor", async () => {
  const overlay = await takeControl(); imageGeometry(); select("Touch mode", "trackpad");
  pointer(overlay, "pointerdown", 20, 20); pointer(overlay, "pointermove", 60, 20); pointer(overlay, "pointerup", 60, 20);
  expect(commands()).toEqual([{type: "MouseMove", x: 768, y: 360}]);
  select("Touch action", "right"); pointer(overlay, "pointerdown", 20, 20); pointer(overlay, "pointerup", 20, 20);
  expect(commands().slice(1)).toEqual([{type: "MouseDown", x: 768, y: 360, button: "right"}, {type: "MouseUp", x: 768, y: 360, button: "right"}]);
});
it("drags to a clamped image edge, releases on cancel, and does not click a cancelled gesture", async () => {
  const overlay = await takeControl(); imageGeometry(); select("Touch action", "drag");
  pointer(overlay, "pointerdown", 200, 200); pointer(overlay, "pointermove", 500, 500); pointer(overlay, "pointercancel", 500, 500); pointer(overlay, "pointerup", 500, 500);
  expect(commands()).toEqual([{type: "MouseDown", x: 640, y: 360, button: "left"}, {type: "MouseMove", x: 1279, y: 719}, {type: "MouseUp", x: 1279, y: 719, button: "left"}]);
});
it("scrolls with a finger gesture without pressing a remote mouse button", async () => {
  const overlay = await takeControl(); imageGeometry(); select("Touch action", "scroll");
  pointer(overlay, "pointerdown", 200, 200); pointer(overlay, "pointermove", 200, 320); pointer(overlay, "pointerup", 200, 320);
  expect(commands()).toEqual([{type: "MouseScroll", delta_x: 0, delta_y: -3}]);
});
it("commits composed Unicode exactly once and never forwards an IME draft key", async () => {
  const overlay = await takeControl(); await click("Software keyboard");
  const input = host.querySelector("textarea")!;
  act(() => input.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true})));
  text("日本😀"); key(overlay, "Process");
  expect([...host.querySelectorAll("button")].find(b => b.textContent === "Send text")!.disabled).toBe(true); expect(send).not.toHaveBeenCalled();
  act(() => input.dispatchEvent(new CompositionEvent("compositionend", {data: "日本😀", bubbles: true})));
  text("日本😀"); await click("Send text"); await click("Send text");
  expect(commands()).toEqual([{type: "TypeText", text: "日本😀"}]); expect(input.value).toBe("");
});
it("clears composition and draft on window blur and cancels a late composition end", async () => {
  await takeControl(); await click("Software keyboard"); const input = host.querySelector("textarea")!;
  act(() => input.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true}))); text("draft");
  act(() => window.dispatchEvent(new Event("blur")));
  act(() => input.dispatchEvent(new CompositionEvent("compositionend", {data: "draft", bubbles: true})));
  text("draft");
  await click("Send text"); expect(send).not.toHaveBeenCalled(); expect(input.value).toBe("");
});
it("bounds text packets by Unicode characters and rejects oversized drafts without sending a prefix", async () => {
  await takeControl(); await click("Software keyboard"); const value = "😀".repeat(513); text(value); await click("Send text");
  expect(commands().map(command => Array.from(command.text as string).length)).toEqual([512, 1]); expect(commands().map(command => command.text).join("")).toBe(value);
  send.mockClear(); text("a".repeat(8001)); await click("Send text"); expect(send).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')!.textContent).toContain("8,000");
});
it.each(["viewer", "unknown capability", "offline"])("blocks all new remote input for %s", async reason => {
  const overlay = await takeControl(); key(overlay, "Shift"); send.mockClear();
  await act(async () => root.render(<ScreenTab agentId="device" embedded sendWsMessage={send} online={reason !== "offline"} dashboardRole={reason === "viewer" ? "viewer" : "operator"} agentInfo={reason === "unknown capability" ? {} : {capabilities: {remote_input: "supported"}}} />));
  expect(commands()).toEqual([{type: "KeyUp", key: "shift"}]); send.mockClear();
  const shortcuts = host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remote "]'); shortcuts.forEach(button => expect(button.disabled).toBe(true));
  await act(async () => shortcuts.forEach(button => button.click())); expect(send).not.toHaveBeenCalled();
});
it("changes zoom and pans locally without sending remote commands", async () => {
  await render(); const img = imageGeometry(); await click("Zoom +"); select("Touch action", "pan");
  const overlay = host.querySelector<HTMLElement>('[role="application"]')!;
  overlay.getBoundingClientRect = img.getBoundingClientRect;
  pointer(overlay, "pointerdown", 200, 200); pointer(overlay, "pointermove", 280, 200); pointer(overlay, "pointerup", 280, 200);
  expect(img.style.transform).toBe("translate(80px, 0px) scale(1.5)"); expect(send).not.toHaveBeenCalled();
  await click("Fit view (1.5×)"); expect(img.style.transform).toBe("translate(0px, 0px) scale(1)");
});
it("does not carry control consent or a delayed clipboard paste to another device", async () => {
  let resolve!: (text: string) => void;
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {readText: () => new Promise<string>(r => {resolve = r;})}});
  const overlay = await takeControl(); key(overlay, "Control"); key(overlay, "v", true);
  await act(async () => root.render(<ScreenTab agentId="other-device" embedded sendWsMessage={send} dashboardRole="operator" agentInfo={{capabilities: {remote_input: "supported"}}} />));
  await act(async () => resolve("stale text"));
  expect(host.querySelector('[role="application"]')).toBeNull();
  expect(send.mock.calls.map(call => [call[0].agent_id, call[0].cmd])).toEqual([["device", {type: "KeyDown", key: "control"}], ["device", {type: "KeyUp", key: "control"}]]);
});
it("keeps shortcuts and an exit button inside the maximized viewer", async () => {
  await takeControl(); await click("Maximize view");
  expect(host.querySelector(".screen-remote-maximized .screen-remote-tools")?.textContent).toContain("Exit fullscreen");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remote tab"]')!.click());
  expect(commands()).toEqual([{type: "KeyPress", key: "tab"}]);
  await click("Exit fullscreen"); expect(host.querySelector(".screen-remote-maximized")).toBeNull();
});
it("does not interpret a finger lift far from its start as a tap when no move event arrived", async () => {
  const overlay = await takeControl(); imageGeometry();
  pointer(overlay, "pointerdown", 200, 200); pointer(overlay, "pointerup", 250, 200);
  expect(send).not.toHaveBeenCalled();
});
