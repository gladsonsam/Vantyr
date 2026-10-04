import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteClipboardPanel } from "./RemoteClipboardPanel";
import { ApiError } from "../../lib/api";
import { CLIPBOARD_TIMEOUT_MS } from "../../lib/remoteClipboard";
import { deferred } from "../../hooks/mjpegTestFixtures";

const backend = vi.hoisted(() => ({ me: vi.fn(), agentModules: vi.fn(), agentClipboard: vi.fn() }));
vi.mock("../../lib/api", async importOriginal => ({...await importOriginal<typeof import("../../lib/api")>(),api:backend}));
vi.mock("../../demo/mode", () => ({isDemoMode:false}));
let host: HTMLDivElement, root: Root;
const status = () => ({online:true,authorization_current:true,state:{modules:[{module:"clipboard",available:true,enabled:true,authorization_required:false}]}});
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  backend.me.mockReset().mockResolvedValue({id:"account-a",role:"operator"});
  backend.agentModules.mockReset().mockResolvedValue(status());backend.agentClipboard.mockReset().mockResolvedValue({ok:true,text:"remote 日本😀"});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();Reflect.deleteProperty(navigator,"clipboard");vi.useRealTimers();vi.restoreAllMocks();});
async function render(device="device", token="lease",supported=true){await act(async()=>root.render(<RemoteClipboardPanel key={`${device}:${token}`} agentId={device} controlToken={token} supported={supported}/>));}
function button(label:string){return [...host.querySelectorAll("button")].find(b=>b.textContent===label)!;}
async function click(label:string){await act(async()=>button(label).click());}
function text(value:string){act(()=>{const input=host.querySelector<HTMLTextAreaElement>('[aria-label="Text to send to device clipboard"]')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}
const draft=()=>host.querySelector<HTMLTextAreaElement>('[aria-label="Text to send to device clipboard"]')!.value;
const result=()=>host.querySelector<HTMLTextAreaElement>('[aria-label="Device clipboard text"]');
it("does not read either clipboard automatically; browser import requires a separate send and device fetch a separate copy",async()=>{
  const readText=vi.fn().mockResolvedValue("local 日本😀"),writeText=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText,writeText}});
  await render();expect(readText).not.toHaveBeenCalled();expect(backend.agentClipboard).not.toHaveBeenCalled();expect(writeText).not.toHaveBeenCalled();
  await click("Load browser clipboard text");expect(draft()).toBe("local 日本😀");expect(backend.agentClipboard).not.toHaveBeenCalled();
  await click("Send to device clipboard");expect(backend.agentClipboard.mock.calls[0].slice(0,2)).toEqual(["device",{action:"write",control_token:"lease",text:"local 日本😀"}]);
  await click("Fetch device clipboard text");expect(result()!.value).toBe("remote 日本😀");expect(writeText).not.toHaveBeenCalled();
  await click("Copy to browser clipboard");expect(writeText).toHaveBeenCalledExactlyOnceWith("remote 日本😀");
});
it.each(["missing", "denied"])("offers manual text when browser read is %s",async reason=>{
  if(reason==="denied")Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:vi.fn().mockRejectedValue(new Error("secret clipboard content"))}});
  await render();await click("Load browser clipboard text");expect(host.textContent).toContain("Paste or type text");expect(host.textContent).not.toContain("secret clipboard content");
  text("manual");await click("Send to device clipboard");expect(backend.agentClipboard.mock.calls[0][1]).toMatchObject({text:"manual"});
});
it("shows fetched device text and selects it for manual copy when browser write fails",async()=>{
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:vi.fn().mockRejectedValue(new Error("denied"))}});
  await render();await click("Fetch device clipboard text");await click("Copy to browser clipboard");
  expect(host.textContent).toContain("Select and copy");expect(document.activeElement).toBe(result());expect(result()!.selectionEnd).toBe(result()!.value.length);
});
it.each(["unknown capability","module disabled","module unavailable","old authorization","viewer"])("requires supported capability, current module grant and operator account: %s",async reason=>{
  const report=status();
  if(reason==="module disabled")report.state.modules[0].enabled=false;
  if(reason==="module unavailable")report.state.modules[0].available=false;
  if(reason==="old authorization")report.authorization_current=false;
  if(reason==="viewer")backend.me.mockResolvedValue({id:"account-a",role:"viewer"});
  backend.agentModules.mockResolvedValue(report);await render("device","lease",reason!=="unknown capability");
  expect(button("Send to device clipboard").disabled).toBe(true);expect(button("Fetch device clipboard text").disabled).toBe(true);expect(backend.agentClipboard).not.toHaveBeenCalled();
});
it("allows exactly 64 KiB of UTF-8, rejects oversized manual or fetched Unicode text without partial transfer",async()=>{
  await render();text("😀".repeat(16384));await click("Send to device clipboard");expect(backend.agentClipboard).toHaveBeenCalledTimes(1);
  text("😀".repeat(16385));await click("Send to device clipboard");expect(backend.agentClipboard).toHaveBeenCalledTimes(1);expect(host.querySelector('[role="alert"]')!.textContent).toContain("64 KiB");
  backend.agentClipboard.mockResolvedValue({ok:true,text:"😀".repeat(16385)});await click("Fetch device clipboard text");expect(result()).toBeNull();expect(host.querySelector('[role="alert"]')!.textContent).toContain("64 KiB");
});
it("rejects oversized browser imports",async()=>{
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:vi.fn().mockResolvedValue("a".repeat(65537))}});
  await render();await click("Load browser clipboard text");expect(draft()).toBe("");expect(host.querySelector('[role="alert"]')!.textContent).toContain("64 KiB");expect(backend.agentClipboard).not.toHaveBeenCalled();
});
it.each([403,413,503,500])("displays content-free errors for HTTP %i",async code=>{
  backend.agentClipboard.mockRejectedValue(new ApiError("DO NOT DISPLAY CONTENT",code));await render();await click("Fetch device clipboard text");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();expect(host.textContent).not.toContain("DO NOT DISPLAY CONTENT");expect(result()).toBeNull();
});
it("disables duplicate actions while pending, times out, and ignores a late result after retry",async()=>{
  vi.useFakeTimers();const pending=deferred<{ok:true;text:string}>();backend.agentClipboard.mockReturnValueOnce(pending.promise);
  await render();await click("Fetch device clipboard text");expect(button("Fetch device clipboard text").disabled).toBe(true);await click("Fetch device clipboard text");expect(backend.agentClipboard).toHaveBeenCalledTimes(1);
  await act(async()=>vi.advanceTimersByTime(CLIPBOARD_TIMEOUT_MS));expect(host.textContent).toContain("timed out");expect(backend.agentClipboard.mock.calls[0][2].aborted).toBe(true);
  await click("Fetch device clipboard text");expect(result()!.value).toBe("remote 日本😀");await act(async()=>pending.resolve({ok:true,text:"stale secret"}));expect(result()!.value).toBe("remote 日本😀");
});
it.each(["device","control","logout","hidden","server"])("clears text and ignores in-flight device results on %s changes",async reason=>{
  const pending=deferred<{ok:true;text:string}>();await render();text("draft secret");backend.agentClipboard.mockReturnValueOnce(pending.promise);await click("Fetch device clipboard text");
  if(reason==="device")await render("other");
  if(reason==="control")await render("device","new-lease");
  if(reason==="logout")act(()=>window.dispatchEvent(new Event("vantyr-session-expired")));
  if(reason==="server")act(()=>window.dispatchEvent(new StorageEvent("storage",{key:"vantyr-server-settings"})));
  if(reason==="hidden"){vi.spyOn(document,"hidden","get").mockReturnValue(true);act(()=>document.dispatchEvent(new Event("visibilitychange")));}
  await act(async()=>pending.resolve({ok:true,text:"stale secret"}));expect(draft()).toBe("");expect(result()).toBeNull();expect(host.textContent).not.toContain("stale secret");
});
it("clears draft/result for an account change detected while a clipboard result is pending",async()=>{
  const pending=deferred<{ok:true;text:string}>();await render();text("draft secret");backend.agentClipboard.mockReturnValueOnce(pending.promise);await click("Fetch device clipboard text");
  backend.me.mockResolvedValue({id:"account-b",role:"operator"});await act(async()=>pending.resolve({ok:true,text:"account-a secret"}));
  expect(draft()).toBe("");expect(result()).toBeNull();expect(button("Fetch device clipboard text").disabled).toBe(true);expect(host.textContent).not.toContain("account-a secret");
});
it("rechecks module permission before sending, preventing a stale grant from transferring text",async()=>{
  await render();text("draft");const revoked=status();revoked.state.modules[0].enabled=false;backend.agentModules.mockResolvedValue(revoked);
  await click("Send to device clipboard");expect(backend.agentClipboard).not.toHaveBeenCalled();expect(draft()).toBe("");
});
it("does not send an unfinished clipboard IME draft",async()=>{
  await render();const field=host.querySelector("textarea")!;act(()=>field.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));text("日本");
  await click("Send to device clipboard");expect(backend.agentClipboard).not.toHaveBeenCalled();
  act(()=>field.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));await click("Send to device clipboard");expect(backend.agentClipboard.mock.calls[0][1]).toMatchObject({text:"日本"});
});
it("ignores a delayed browser read after a device switch",async()=>{
  const pending=deferred<string>();Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:()=>pending.promise}});
  await render();await click("Load browser clipboard text");await render("other");await act(async()=>pending.resolve("old browser secret"));
  expect(draft()).toBe("");expect(backend.agentClipboard).not.toHaveBeenCalled();
});
it("bounds hung permission verification and ignores its late result",async()=>{
  vi.useFakeTimers();const pending=deferred<ReturnType<typeof status>>();backend.agentModules.mockReturnValue(pending.promise);
  await render();expect(button("Fetch device clipboard text").disabled).toBe(true);await act(async()=>vi.advanceTimersByTime(CLIPBOARD_TIMEOUT_MS));
  expect(host.textContent).toContain("verification timed out");await act(async()=>pending.resolve(status()));expect(button("Fetch device clipboard text").disabled).toBe(true);
});
it("verifies the account again before browser copy and does not copy another account's fetched text",async()=>{
  const writeText=vi.fn();Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
  await render();await click("Fetch device clipboard text");backend.me.mockResolvedValue({id:"account-b",role:"operator"});
  await click("Copy to browser clipboard");expect(writeText).not.toHaveBeenCalled();expect(result()).toBeNull();expect(draft()).toBe("");
});
it("clears draft and result when clipboard capability becomes unavailable",async()=>{
  await render();text("private draft");await click("Fetch device clipboard text");await render("device","lease",false);
  expect(draft()).toBe("");expect(result()).toBeNull();expect(button("Fetch device clipboard text").disabled).toBe(true);
});
