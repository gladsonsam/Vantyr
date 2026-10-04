import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScreenTab } from "./ScreenTab";
import { deferred, frameGeometry, frameJpeg, framePart, settle } from "../../hooks/mjpegTestFixtures";
import type { AgentInfo } from "../../lib/types";

const clipboardApi = vi.hoisted(() => ({ me: vi.fn(), agentModules: vi.fn(), agentClipboard: vi.fn() }));
const mode = vi.hoisted(() => ({demo:true}));
vi.mock("../../demo/mode", () => ({ get isDemoMode() {return mode.demo;} }));
vi.mock("../../demo/fakeScreen", () => ({ DemoScreen: () => <div>Demo screen</div> }));
vi.mock("../../lib/api", () => ({ mjpegStreamUrl: (id: string, session: string, _tuning: unknown, monitor?: number) => `https://server.example/mjpeg?agent=${id}&session=${session}${monitor === undefined ? "" : `&monitor=${monitor}`}`, notifyMjpegViewerLeft: vi.fn(), apiUrl: (path: string) => path, api: clipboardApi, isApiError: () => false }));
let host: HTMLDivElement, root: Root;
const send = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mode.demo = true;
  clipboardApi.me.mockReset().mockResolvedValue({id:"operator",role:"operator"});
  clipboardApi.agentModules.mockReset().mockResolvedValue({online:true,authorization_current:true,state:{modules:[{module:"clipboard",available:true,enabled:true,authorization_required:false}]}});
  clipboardApi.agentClipboard.mockReset().mockResolvedValue({ok:true,text:"device text"});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); send.mockReset();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {configurable: true, value: vi.fn()});
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, "clipboard"); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(active = true, online = true, id = "device", monitors?: AgentInfo["monitors"]) {
  await act(async () => root.render(<ScreenTab agentId={id} embedded streamActive={active} online={online} sendWsMessage={send} dashboardRole="operator" agentInfo={{capabilities: {remote_input: "supported", clipboard: "supported", screen_capture: "supported"},monitors}} />));
}
async function takeControl() {
  await render(); closeTools();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Take control"))!;
  await act(async () => button.click());
  const request = send.mock.calls.find(call => call[0].type === "control_acquire")![0];
  await act(async () => window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: { event: "control_lease", agent_id: "device", request_id: request.request_id, status: "granted", lease_token: "test-lease", expires_in_ms: 15000 } })));
  send.mockClear();
  return host.querySelector<HTMLElement>('[role="application"]')!;
}
function key(overlay: HTMLElement, value: string, ctrlKey = false) {
  act(() => overlay.dispatchEvent(new KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true, cancelable: true })));
}
it("releases held modifiers on window blur and does not send duplicate keydown or keyup", async () => {
  const overlay = await takeControl();
  key(overlay, "Control"); key(overlay, "Control");
  expect(commands()).toEqual([{ type: "KeyDown", key: "control" }]);
  act(() => window.dispatchEvent(new Event("blur")));
  act(() => overlay.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", bubbles: true })));
  expect(commands()).toEqual([{ type: "KeyDown", key: "control" }, { type: "KeyUp", key: "control" }]);
});
it("forwards native remote Ctrl+V without reading the browser clipboard, then releases held inputs when hidden", async () => {
  const readText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {readText} });
  const overlay = await takeControl(); key(overlay, "Control"); key(overlay, "v", true);
  await render(false);
  expect(readText).not.toHaveBeenCalled();
  expect(commands()).toEqual([{ type: "KeyDown", key: "control" }, {type:"KeyChar",char:"v"}, { type: "KeyUp", key: "control" }]);
});
it("releases control on device disconnect and disables reacquisition while offline", async () => {
  const overlay = await takeControl(); key(overlay, "Shift");
  await render(true, false);
  expect(host.querySelector('[role="application"]')).toBeNull();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Take control"))!;
  expect(button.disabled).toBe(true);
  expect(commands()).toEqual([{ type: "KeyDown", key: "shift" }, { type: "KeyUp", key: "shift" }]);
});

function imageGeometry() {
  const img = host.querySelector<HTMLImageElement>("img")!;
  Object.defineProperty(img, "naturalWidth", {configurable: true, value: 1280});
  Object.defineProperty(img, "naturalHeight", {configurable: true, value: 720});
  img.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({})});
  return img;
}
function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1) {
  closeTools();
  act(() => { const event = new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerType: {value: "touch"}, pointerId: {value: id}, isPrimary: {value: true}}); target.dispatchEvent(event); });
}
function openTools(group?: string) {
  if (!host.querySelector(".remote-tools-sheet")) act(() => host.querySelector<HTMLButtonElement>('button[aria-label="More tools"]')!.click());
  if (group) {
    const button = [...host.querySelectorAll<HTMLButtonElement>(".remote-tool-group-toggle")].find(b => b.textContent?.trim() === group)!;
    if (button.getAttribute("aria-expanded") !== "true") act(() => button.click());
  }
}
function closeTools() { const close=host.querySelector<HTMLButtonElement>('[aria-label="Close remote tools"]');if(close)act(()=>close.click()); }
function select(label: string, value: string) { openTools(["Touch mode","Touch action"].includes(label)?"Pointer & gestures":"View & stream"); act(() => { const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new Event("change", {bubbles: true})); }); }
async function click(label: string) {
  if (["Software keyboard", "Maximize view", "Exit fullscreen"].includes(label)) closeTools();
  if (label.startsWith("Zoom") || label.startsWith("Fit view")) openTools("View & stream");
  if (label==="Send notification") openTools("Audio & notification");
  if (label==="Text clipboard") openTools();
  await act(async () => [...host.querySelectorAll("button")].find(b => b.getAttribute("aria-label")===label || b.textContent?.trim() === label || (label === "Text clipboard" && b.textContent?.startsWith(label)))!.click());
}
function text(value: string) { act(() => { const input = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", {bubbles: true})); }); }
const commands = () => send.mock.calls.filter(call => call[0].type === "control").map(call => call[0].cmd);
it("sends embedded notifications only with a confirmed lease and prevents sending after control ends", async () => {
  await render();
  openTools("Audio & notification"); expect([...host.querySelectorAll("button")].find(b => b.textContent === "Send notification")!.disabled).toBe(true);
  await takeControl();
  await click("Send notification");
  const title = host.querySelector<HTMLInputElement>('input[aria-label="Notification title"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Hello");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Send");
  expect(send.mock.calls.find(call => call[0].cmd?.type === "Notify")![0]).toMatchObject({
    type: "control", agent_id: "device", lease_token: "test-lease",
    cmd: { type: "Notify", title: "Hello", message: "" },
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await click("Send notification");
  act(() => window.dispatchEvent(new Event("blur")));
  expect([...host.querySelectorAll("button")].find(b => b.textContent === "Send")!.disabled).toBe(true);
  expect(commands().filter(cmd => cmd.type === "Notify")).toHaveLength(1);
});
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
  await click("Send text"); expect(commands()).toEqual([]); expect(input.value).toBe("");
});
it("bounds text packets by Unicode characters and rejects oversized drafts without sending a prefix", async () => {
  await takeControl(); await click("Software keyboard"); const value = "😀".repeat(513); text(value); await click("Send text");
  expect(commands().map(command => Array.from(command.text as string).length)).toEqual([512, 1]); expect(commands().map(command => command.text).join("")).toBe(value);
  send.mockClear(); text("a".repeat(8001)); await click("Send text"); expect(commands()).toEqual([]); expect(host.querySelector('[role="alert"]')!.textContent).toContain("8,000");
});
it.each(["viewer", "unknown capability", "offline"])("blocks all new remote input for %s", async reason => {
  const overlay = await takeControl(); key(overlay, "Shift"); send.mockClear();
  await act(async () => root.render(<ScreenTab agentId="device" embedded sendWsMessage={send} online={reason !== "offline"} dashboardRole={reason === "viewer" ? "viewer" : "operator"} agentInfo={reason === "unknown capability" ? {} : {capabilities: {remote_input: "supported"}}} />));
  expect(commands()).toEqual([{type: "KeyUp", key: "shift"}]); send.mockClear();
  openTools("Remote keys");
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
it("does not carry control consent to another device", async () => {
  const overlay = await takeControl(); key(overlay, "Control");
  await act(async () => root.render(<ScreenTab agentId="other-device" embedded sendWsMessage={send} dashboardRole="operator" agentInfo={{capabilities: {remote_input: "supported"}}} />));
  expect(host.querySelector('[role="application"]')).toBeNull();
  expect(send.mock.calls.filter(call => call[0].type === "control").map(call => [call[0].agent_id, call[0].cmd])).toEqual([["device", {type: "KeyDown", key: "control"}], ["device", {type: "KeyUp", key: "control"}]]);
});
it("keeps shortcuts and an exit button inside the maximized viewer", async () => {
  await takeControl(); await click("Maximize view");
  expect(host.querySelector(".screen-remote-maximized .screen-remote-tools")?.textContent).toContain("Exit fullscreen");
  openTools("Remote keys");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remote tab"]')!.click());
  expect(commands()).toEqual([{type: "KeyPress", key: "tab"}]);
  await click("Exit fullscreen"); expect(host.querySelector(".screen-remote-maximized")).toBeNull();
});
it("does not interpret a finger lift far from its start as a tap when no move event arrived", async () => {
  const overlay = await takeControl(); imageGeometry();
  pointer(overlay, "pointerdown", 200, 200); pointer(overlay, "pointerup", 250, 200);
  expect(send).not.toHaveBeenCalled();
});
it("ends control and displays a server module denial without accepting another device's event", async () => {
  const overlay = await takeControl(); key(overlay, "Shift");
  act(() => window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: { event: "command_rejected", agent_id: "other", module: "remote_input", error: "other denial" } })));
  expect(host.querySelector('[role="application"]')).not.toBeNull();
  act(() => window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: { event: "command_rejected", agent_id: "device", module: "remote_input", error: "Authorize remote input on the device" } })));
  expect(host.querySelector('[role="application"]')).toBeNull();
  expect(host.textContent).toContain("Authorize remote input on the device");
  expect(commands()).toEqual([{ type: "KeyDown", key: "shift" }, { type: "KeyUp", key: "shift" }]);
  key(overlay, "a"); expect(commands()).toHaveLength(2);
});
it("waits for a lease and shows a denied control request without sending input", async () => {
  await render(); await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Take control"))!.click());
  expect(host.querySelector('[role="application"]')).toBeNull();
  expect(host.textContent).toContain("Requesting");
  const request = send.mock.calls[0][0];
  expect(request).toMatchObject({type: "control_acquire", agent_id: "device"});
  act(() => window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: { event: "control_lease", agent_id: "device", request_id: request.request_id, status: "denied", error: "Another operator has control" } })));
  expect(host.textContent).toContain("Another operator has control"); expect(commands()).toEqual([]);
});

function realTransport() {
  mode.demo=false;
  const streams: {url:string; controller:ReadableStreamDefaultController<Uint8Array>; cancel:ReturnType<typeof vi.fn>}[]=[];
  const fetcher=vi.fn(async (url:string) => {
    let controller!:ReadableStreamDefaultController<Uint8Array>; const cancel=vi.fn();
    const body=new ReadableStream<Uint8Array>({start:c=>{controller=c;},cancel}); streams.push({url,controller,cancel});
    return new Response(body,{headers:{"Content-Type":"multipart/x-mixed-replace; boundary=testframe"}});
  });
  const decode=vi.fn().mockImplementation(async()=>({width:16,height:24,close:vi.fn()} as unknown as ImageBitmap));
  const draw=vi.fn(); vi.stubGlobal("fetch",fetcher);vi.stubGlobal("createImageBitmap",decode);
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
  return {streams,decode,draw,fetcher};
}
function canvasBounds(left=0,top=0,width=400,height=400) {
  const canvas=host.querySelector("canvas")!; canvas.getBoundingClientRect=()=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON:()=>({})}); return canvas;
}
async function grantRenderedControl() {
  const button=[...host.querySelectorAll("button")].find(b=>b.textContent?.includes("Take control"))!; expect(button.disabled).toBe(false);
  await act(async()=>button.click()); const request=send.mock.calls.filter(call=>call[0].type==="control_acquire").slice(-1)[0][0];
  await act(async()=>window.dispatchEvent(new CustomEvent("vantyr-ws-event",{detail:{event:"control_lease",agent_id:request.agent_id,request_id:request.request_id,status:"granted",lease_token:"test-lease",expires_in_ms:15000}})));
  send.mockClear(); return {overlay:host.querySelector<HTMLElement>('[role="application"]')!,request};
}
it("fetches the real server URL with credentials and stamps transformed touch coordinates from displayed pixels",async()=>{
  const t=realTransport();await render();await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});
  expect(host.querySelector("img")).toBeNull();expect(t.fetcher.mock.calls[0][0]).toContain("https://server.example/");
  const {overlay,request}=await grantRenderedControl(); expect(request.capture_session).toBe(new URL(t.streams[0].url).searchParams.get("session"));expect(request).toMatchObject({capture_id:frameGeometry().capture_id,geometry_revision:1});
  await click("Zoom +"); const canvas=canvasBounds(-100,-60,600,600); expect(canvas.style.transform).toContain("scale(1.5)");
  pointer(overlay,"pointerdown",200,240);pointer(overlay,"pointerup",200,240);
  expect(commands()).toEqual([{type:"MouseDown",x:8,y:12,button:"left",capture_id:frameGeometry().capture_id,geometry_revision:1},{type:"MouseUp",x:8,y:12,button:"left",capture_id:frameGeometry().capture_id,geometry_revision:1}]);
});
it("acquires against the displayed frame while a newer capture is still decoding",async()=>{
  const t=realTransport();await render();await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});
  const next=deferred<ImageBitmap>();t.decode.mockReturnValueOnce(next.promise);
  await act(async()=>{t.streams[0].controller.enqueue(framePart(frameJpeg(frameGeometry(2))));await settle();});
  const {request}=await grantRenderedControl();expect(request).toMatchObject({capture_id:frameGeometry().capture_id,geometry_revision:1});
  await act(async()=>{next.resolve({width:16,height:24,close:vi.fn()} as unknown as ImageBitmap);await settle();});
  expect(send.mock.calls.some(call=>call[0].type==="control_release")).toBe(true);
});
it("keeps input bound to displayed geometry during decode and releases held input with its old stamp on replacement",async()=>{
  const t=realTransport();await render();await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});const {overlay}=await grantRenderedControl();canvasBounds();select("Touch action","drag");
  pointer(overlay,"pointerdown",200,200);key(overlay,"Shift");
  const next=deferred<ImageBitmap>();t.decode.mockReturnValueOnce(next.promise);
  await act(async()=>{t.streams[0].controller.enqueue(framePart(frameJpeg(frameGeometry(2))));await settle();});
  key(overlay,"Enter");expect(commands().slice(-1)[0]).toMatchObject({type:"KeyPress",geometry_revision:1});
  await act(async()=>{next.resolve({width:16,height:24,close:vi.fn()} as unknown as ImageBitmap);await settle();});
  expect(commands().filter(c=>c.type==="KeyUp"||c.type==="MouseUp")).toEqual([{type:"KeyUp",key:"shift",capture_id:frameGeometry().capture_id,geometry_revision:1},{type:"MouseUp",button:"left",x:8,y:12,capture_id:frameGeometry().capture_id,geometry_revision:1}]);
  expect(host.querySelector('[role="application"]')).toBeNull();
  const resumed=await grantRenderedControl();expect(resumed.request).toMatchObject({capture_id:frameGeometry(2).capture_id,geometry_revision:2});
  key(resumed.overlay,"Enter");expect(commands().slice(-1)[0]).toMatchObject({type:"KeyPress",geometry_revision:2});
});
it("disables all new input for unverified metadata and releases the controller on stream error",async()=>{
  const t=realTransport();await render();await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});const {overlay}=await grantRenderedControl();key(overlay,"Shift");send.mockClear();
  await act(async()=>{t.streams[0].controller.enqueue(framePart(frameJpeg({bad:true})));await settle();});
  expect(host.textContent).toContain("View only. Verified display geometry required");expect(commands()).toEqual([{type:"KeyUp",key:"shift",capture_id:frameGeometry().capture_id,geometry_revision:1}]);
  expect(send.mock.calls.some(call=>call[0].type==="control_release")).toBe(true);send.mockClear();pointer(overlay,"pointerdown",200,200);key(overlay,"Enter");expect(commands()).toEqual([]);
  await act(async()=>{t.streams[0].controller.error(new Error("Connection lost"));await settle();});expect(host.textContent).toContain("Live view disconnected. Reconnect in More tools.");expect(host.querySelector("canvas")?.width).toBe(1);
});
it.each([{desktop:null}, {monitor_index:null}, {monitor_index:64}])("keeps unavailable physical metadata %j view-only without offering acquisition or keyboard/scroll input",async missing=>{
  const t=realTransport();await render();await act(async()=>{t.streams[0].controller.enqueue(framePart(frameJpeg({...frameGeometry(),...missing})));await settle();});canvasBounds();
  expect(host.textContent).toContain("View only. Verified display geometry required");
  const acquire=Array.from(host.querySelectorAll("button")).find(button=>button.textContent?.includes("Take control"))!;
  expect(acquire.disabled).toBe(true);select("Touch action","pan");const overlay=host.querySelector<HTMLElement>('[aria-label="Pan local screen view"]')!;
  pointer(overlay,"pointerdown",200,200);pointer(overlay,"pointerup",200,200);key(overlay,"Enter");
  expect(commands()).toEqual([]);expect(send.mock.calls.some(call=>call[0].type==="control_acquire")).toBe(false);
});
it("releases control before a monitor change and requires a verified new frame and explicit reacquisition",async()=>{
  const t=realTransport(), monitors=[{index:0,name:"Primary",width:1920,height:1080,primary:true},{index:1,name:"Portrait",width:1080,height:1920,primary:false}];
  await render(true,true,"device",monitors);await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});const {overlay,request:old}=await grantRenderedControl();key(overlay,"Shift");
  select("Monitor","1");await act(async()=>settle());expect(t.streams[0].cancel).toHaveBeenCalled();expect(t.streams.slice(-1)[0].url).toContain("monitor=1");
  const releaseIndex=send.mock.calls.findIndex(call=>call[0].type==="control_release");expect(releaseIndex).toBeGreaterThan(-1);expect(commands().find(c=>c.type==="KeyUp")).toMatchObject({type:"KeyUp",geometry_revision:1});
  expect([...host.querySelectorAll("button")].find(b=>b.textContent?.includes("Take control"))!.disabled).toBe(true);expect(host.querySelector("canvas")?.width).toBe(1);
  await act(async()=>{t.streams.slice(-1)[0].controller.enqueue(framePart(frameJpeg(frameGeometry(2))));await settle();});
  const {request:next}=await grantRenderedControl();expect(next.capture_session).not.toBe(old.capture_session);
});
it("does not publish an obsolete decode or carry held keys/control to a replacement device",async()=>{
  const t=realTransport();await render();await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});const {overlay}=await grantRenderedControl();key(overlay,"Control");
  const stale=deferred<ImageBitmap>();t.decode.mockReturnValueOnce(stale.promise);await act(async()=>{t.streams[0].controller.enqueue(framePart(frameJpeg(frameGeometry(2))));await settle();});
  await render(true,true,"other");expect(commands().filter(c=>c.type==="KeyUp")).toEqual([{type:"KeyUp",key:"control",capture_id:frameGeometry().capture_id,geometry_revision:1}]);
  expect(send.mock.calls.filter(call=>call[0].type==="control").every(call=>call[0].agent_id==="device")).toBe(true);
  const before=t.draw.mock.calls.length, close=vi.fn();await act(async()=>{stale.resolve({width:16,height:24,close} as unknown as ImageBitmap);await settle();});expect(close).toHaveBeenCalled();expect(t.draw).toHaveBeenCalledTimes(before);expect(host.querySelector("canvas")?.width).toBe(1);expect(host.querySelector('[role="application"]')).toBeNull();
});

it("transfers clipboard text only through the explicit panel with a lease, never typing it", async () => {
  await render(); await click("Text clipboard"); expect(host.textContent).toContain("Take control to use the text clipboard");
  expect(clipboardApi.agentClipboard).not.toHaveBeenCalled();
  await takeControl(); await click("Text clipboard");
  const input=host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text to send to device clipboard"]')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"日本😀");input.dispatchEvent(new Event("input",{bubbles:true}));});
  await click("Send to device clipboard");
  expect(clipboardApi.agentClipboard.mock.calls[0].slice(0,2)).toEqual(["device",{action:"write",control_token:"test-lease",text:"日本😀"}]);
  await click("Fetch device clipboard text"); expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Device clipboard text"]')!.value).toBe("device text");
  expect(commands()).toEqual([]);
  act(()=>window.dispatchEvent(new CustomEvent("vantyr-ws-event",{detail:{event:"control_lease",agent_id:"device",status:"revoked",lease_token:"test-lease"}})));
  expect(host.querySelector('textarea[aria-label="Device clipboard text"]')).toBeNull();
  expect(host.querySelector('textarea[aria-label="Text to send to device clipboard"]')).toBeNull();
});
it("cancels a trackpad drag on rotation and ignores the old finger lift", async () => {
  const overlay=await takeControl(), img=imageGeometry(); overlay.getBoundingClientRect=img.getBoundingClientRect;
  select("Touch mode","trackpad");select("Touch action","drag");
  pointer(overlay,"pointerdown",200,200); pointer(overlay,"pointermove",220,200);
  act(()=>window.dispatchEvent(new Event("resize"))); pointer(overlay,"pointerup",220,200);
  expect(commands()).toEqual([{type:"MouseDown",x:640,y:360,button:"left"},{type:"MouseMove",x:704,y:360},{type:"MouseUp",x:704,y:360,button:"left"}]);
});
it("reclamps zoomed pan when the viewport rotates",async()=>{
  await render();const img=imageGeometry(); await click("Zoom +");select("Touch action","pan");
  const overlay=host.querySelector<HTMLElement>('[role="application"]')!, stage=host.querySelector<HTMLElement>(".screen-remote-stage")!;
  overlay.getBoundingClientRect=img.getBoundingClientRect; stage.getBoundingClientRect=img.getBoundingClientRect;
  pointer(overlay,"pointerdown",200,200);pointer(overlay,"pointermove",280,200);pointer(overlay,"pointerup",280,200);
  stage.getBoundingClientRect=()=>({left:0,top:0,width:200,height:400,right:200,bottom:400,x:0,y:0,toJSON:()=>({})});
  act(()=>window.dispatchEvent(new Event("resize")));expect(img.style.transform).toBe("translate(50px, 0px) scale(1.5)");expect(commands()).toEqual([]);
});
it("falls back to the maximized view when native fullscreen rejects",async()=>{
  await render();Object.defineProperty(HTMLElement.prototype,"requestFullscreen",{configurable:true,value:vi.fn().mockRejectedValue(new Error("Denied"))});
  await click("Maximize view");expect(host.querySelector(".screen-remote-maximized")).not.toBeNull();await click("Exit fullscreen");expect(host.querySelector(".screen-remote-maximized")).toBeNull();
  Reflect.deleteProperty(HTMLElement.prototype,"requestFullscreen");
});
it("accumulates small trackpad wheel deltas rather than dropping scroll",async()=>{
  const overlay=await takeControl();
  act(()=>{for(let i=0;i<5;i++)overlay.dispatchEvent(new WheelEvent("wheel",{deltaY:25,bubbles:true,cancelable:true}));});
  expect(commands()).toEqual([{type:"MouseScroll",delta_x:0,delta_y:1}]);
});

it("retains the lease and capture session across repeated visible notifications",async()=>{
  await takeControl();const before=host.querySelector("img")!.src;
  act(()=>{for(let i=0;i<5;i++)document.dispatchEvent(new Event("visibilitychange"));});
  expect(host.querySelector("img")!.src).toBe(before);expect(host.querySelector('[role="application"]')).not.toBeNull();
  expect(send.mock.calls.some(call=>call[0].type==="control_release")).toBe(false);
  await click("Text clipboard");expect(host.querySelector('[aria-label="Text to send to device clipboard"]')).not.toBeNull();
});
it("releases hidden input, reconnects only after a genuine hidden return and requires reacquisition",async()=>{
  const overlay=await takeControl();imageGeometry();select("Touch action","drag");pointer(overlay,"pointerdown",200,200);
  const before=host.querySelector("img")!.src;const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(true);
  act(()=>document.dispatchEvent(new Event("visibilitychange")));expect(host.querySelector('[role="application"]')).toBeNull();
  expect(commands()).toEqual([{type:"MouseDown",x:640,y:360,button:"left"},{type:"MouseUp",x:640,y:360,button:"left"}]);
  hidden.mockReturnValue(false);act(()=>document.dispatchEvent(new Event("visibilitychange")));
  const after=host.querySelector("img")!.src;expect(after).not.toBe(before);expect(host.querySelector('[role="application"]')).toBeNull();
  act(()=>document.dispatchEvent(new Event("visibilitychange")));expect(host.querySelector("img")!.src).toBe(after);
});

it.each([true,false])("starts with just four primary actions and unmounted advanced controls (embedded=%s)",async embedded=>{
  await act(async()=>root.render(<ScreenTab agentId="device" embedded={embedded} sendWsMessage={send} dashboardRole="operator" agentInfo={{capabilities:{remote_input:"supported"}}}/>));
  expect([...host.querySelectorAll("button")].map(b=>b.getAttribute("aria-label"))).toEqual(["Take control","Software keyboard","More tools","Maximize view"]);
  expect(host.querySelector(".remote-tools-sheet")).toBeNull();expect(host.querySelector("select")).toBeNull();expect(host.querySelector("textarea")).toBeNull();
  expect(host.textContent).not.toContain("Direct touch targets");expect(host.textContent).not.toContain("Send notification");
});
it("discloses groups only when requested, traps focus and restores focus/inert state on Escape",async()=>{
  await render();const stage=host.querySelector<HTMLElement>(".screen-remote-stage")!,trigger=host.querySelector<HTMLButtonElement>('[aria-label="More tools"]')!;
  const outside=document.createElement("button");outside.textContent="Outside";outside.inert=true;host.append(outside);
  await click("More tools");expect(trigger.getAttribute("aria-expanded")).toBe("true");expect(stage.inert).toBe(true);expect(host.querySelector("select")).toBeNull();
  const close=host.querySelector<HTMLButtonElement>('[aria-label="Close remote tools"]')!;expect(document.activeElement).toBe(close);
  act(()=>close.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true})));
  expect(document.activeElement?.textContent).toBe("Help");
  act(()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(host.querySelector(".remote-tools-sheet")).toBeNull();expect(Boolean(stage.inert)).toBe(false);expect(outside.inert).toBe(true);expect(document.activeElement).toBe(trigger);outside.remove();
});
it("cancels an in-progress drag on opening More tools while retaining the active lease",async()=>{
  const overlay=await takeControl();imageGeometry();select("Touch action","drag");pointer(overlay,"pointerdown",200,200);
  await click("More tools");expect(commands()).toEqual([{type:"MouseDown",x:640,y:360,button:"left"},{type:"MouseUp",x:640,y:360,button:"left"}]);
  expect(send.mock.calls.some(call=>call[0].type==="control_release")).toBe(false);await click("Close remote tools");pointer(overlay,"pointerup",200,200);expect(commands()).toHaveLength(2);
});
it("keeps the sheet inside fullscreen and consumes Escape before exiting the maximized viewer",async()=>{
  await takeControl();await click("Maximize view");await click("More tools");
  expect(host.querySelector(".screen-remote-maximized .remote-tools-sheet")).not.toBeNull();
  act(()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(host.querySelector(".remote-tools-sheet")).toBeNull();expect(host.querySelector(".screen-remote-maximized")).not.toBeNull();expect(document.activeElement?.getAttribute("aria-label")).toBe("More tools");
  await click("Exit fullscreen");expect(host.querySelector(".screen-remote-maximized")).toBeNull();
});
it("offers notification inside the fullscreen tree after closing the tools sheet",async()=>{
  await takeControl();await click("Maximize view");await click("Send notification");
  expect(host.querySelector(".remote-tools-sheet")).toBeNull();expect(host.querySelector('.screen-remote-maximized [role="dialog"]')?.textContent).toContain("Send notification");
  await click("Cancel");expect(host.querySelector('[role="dialog"]')).toBeNull();expect(host.querySelector(".screen-remote-maximized")).not.toBeNull();
});
it("opens the keyboard separately from clipboard/tools and clears an IME draft when switching tools",async()=>{
  await takeControl();await click("Software keyboard");const field=host.querySelector("textarea")!;
  act(()=>field.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));text("draft 日本");
  await click("More tools");expect(host.querySelector('[aria-label="Remote text"]')).toBeNull();await click("Text clipboard");expect(host.querySelector('[aria-label="Text to send to device clipboard"]')).not.toBeNull();
  await click("Close remote tools");await click("Software keyboard");expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Remote text"]')!.value).toBe("");expect(commands()).toEqual([]);
});
it("clears pending clipboard text on sheet close and ignores its late response",async()=>{
  const pending=deferred<{ok:true;text:string}>();await takeControl();await click("Text clipboard");clipboardApi.agentClipboard.mockReturnValueOnce(pending.promise);await click("Fetch device clipboard text");
  await click("Close remote tools");await act(async()=>pending.resolve({ok:true,text:"stale private text"}));await click("Text clipboard");
  expect(host.querySelector('[aria-label="Device clipboard text"]')).toBeNull();expect(host.textContent).not.toContain("stale private text");
});
it("disables disclosed remote keys and clears clipboard when the lease is revoked",async()=>{
  await takeControl();await click("Text clipboard");await click("Fetch device clipboard text");
  act(()=>window.dispatchEvent(new CustomEvent("vantyr-ws-event",{detail:{event:"control_lease",agent_id:"device",lease_token:"test-lease",status:"revoked",error:"Control ended"}})));
  expect(host.querySelector('[aria-label="Device clipboard text"]')).toBeNull();openTools("Remote keys");
  const keys=host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remote "]');expect(keys).toHaveLength(7);keys.forEach(button=>expect(button.disabled).toBe(true));
  send.mockClear();await act(async()=>keys.forEach(button=>button.click()));expect(send).not.toHaveBeenCalled();expect(host.querySelector('.remote-tools-sheet [role="alert"]')!.textContent).toContain("Control ended");
});
it("closes tools on device change and restores the rest of the page",async()=>{
  await takeControl();await click("Text clipboard");await render(true,true,"other-device");expect(host.querySelector(".remote-tools-sheet")).toBeNull();expect(host.querySelector("textarea")).toBeNull();expect(Boolean(host.querySelector<HTMLElement>(".screen-remote-stage")!.inert)).toBe(false);
});
it("updates the sheet viewport height on resize without carrying a cancelled gesture",async()=>{
  await takeControl();await click("More tools");Object.defineProperty(window,"innerHeight",{configurable:true,value:320});
  act(()=>window.dispatchEvent(new Event("resize")));expect(host.querySelector<HTMLElement>(".screen-remote-panel")!.style.getPropertyValue("--remote-viewport-height")).toBe("320px");
  expect(host.querySelector(".remote-tools-sheet")).not.toBeNull();expect(commands()).toEqual([]);
});

it("does not treat the synthetic demo desktop as a stalled real stream",async()=>{
  vi.useFakeTimers();await render();const img=imageGeometry();act(()=>img.dispatchEvent(new Event("load")));
  await act(async()=>vi.advanceTimersByTime(16000));expect(host.textContent).not.toContain("Live view stalled");expect(host.querySelector<HTMLButtonElement>('[aria-label="Take control"]')!.disabled).toBe(false);vi.useRealTimers();
});
it("closes the sheet and restores inert/scroll state when the stream is hidden",async()=>{
  const overflow=document.body.style.overflow;await takeControl();await click("More tools");expect(document.body.style.overflow).toBe("hidden");
  await render(false);expect(host.querySelector(".remote-tools-sheet")).toBeNull();expect(Boolean(host.querySelector<HTMLElement>(".screen-remote-stage")!.inert)).toBe(false);expect(document.body.style.overflow).toBe(overflow);
});
it("streams the live screen to viewers while keeping control operator-only",async()=>{
  const t=realTransport();
  await act(async()=>root.render(<ScreenTab agentId="device" embedded streamActive online sendWsMessage={send} dashboardRole="viewer" agentInfo={{capabilities:{remote_input:"supported",screen_capture:"supported"}}} />));
  await act(async()=>{t.streams[0].controller.enqueue(framePart());await settle();});
  expect(t.fetcher).toHaveBeenCalledTimes(1);expect(t.draw).toHaveBeenCalled();
  expect([...host.querySelectorAll("button")].find(b=>b.textContent?.includes("Take control"))!.disabled).toBe(true);
  expect(host.textContent).toContain("Operator access is required to take control");
});
