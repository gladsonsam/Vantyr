import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRecallPreferenceKey } from "./useRecallPreferenceKey";
import { RecallSearch } from "../components/recall/RecallSearch";
import { EMPTY_CONTEXT_FILTERS, parseRecallFilters } from "../lib/recallContext";
const {me,search}=vi.hoisted(()=>({me:vi.fn(),search:vi.fn()}));
vi.mock("../lib/api",()=>({api:{me,historySearch:search,historyBlobUrl:()=>"/frame"},errorText:(e:Error)=>e.message}));
function Harness(){const key=useRecallPreferenceKey("device");return <RecallSearch agentId="device" monitor={0} preferencesKey={key} timezone="UTC" initialSearch={{query:"original restored query",scope:"retained",sort:"ranked",monitor:0,filters:EMPTY_CONTEXT_FILTERS}} onSeek={vi.fn()}/>;}
it("keeps the same-account draft and in-flight search across refocus, but clears it for another account/server/logout",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
  let finishIdentity!:(value:{id:string})=>void,finishSearch!:(value:unknown)=>void;
  me.mockReset().mockResolvedValueOnce({id:"user-a"}).mockImplementation(()=>new Promise(resolve=>{finishIdentity=resolve;}));
  search.mockReset().mockImplementation(()=>new Promise(resolve=>{finishSearch=resolve;}));
  const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
  const field=(label:string,value:string)=>act(()=>{const input=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  const button=()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="Search")!;
  const assertDraft=(q:string,app:string)=>{expect(host.querySelector<HTMLInputElement>('[aria-label="Search screen text"]')!.value).toBe(q);expect(host.querySelector<HTMLInputElement>('[aria-label="Foreground app around capture"]')!.value).toBe(app);};
  try {
    await act(async()=>root.render(<Harness/>));field("Search screen text","edited private query");field("Foreground app around capture","Editor.EXE");act(()=>button().click());
    const signal=search.mock.calls[0][3] as AbortSignal;
    await act(async()=>window.dispatchEvent(new Event("focus")));assertDraft("edited private query","Editor.EXE");expect(signal.aborted).toBe(false);
    await act(async()=>{window.dispatchEvent(new Event("focus"));window.dispatchEvent(new Event("focus"));});expect(me).toHaveBeenCalledTimes(2);
    await act(async()=>finishIdentity({id:"user-a"}));assertDraft("edited private query","Editor.EXE");expect(signal.aborted).toBe(false);expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0].slice(0,2)).toEqual(["device","edited private query"]);expect(search.mock.calls[0][2].app).toBe("editor.exe");
    await act(async()=>finishSearch({results:[{id:10,captured_at:"2026-10-03T00:00:00Z",snippet:"current account result"}],filters:parseRecallFilters({app:"editor.exe"}),complete:true}));
    expect(host.textContent).toContain("current account result");
    await act(async()=>window.dispatchEvent(new Event("focus")));expect(host.textContent).toContain("current account result");
    await act(async()=>finishIdentity({id:"user-b"}));assertDraft("","");expect(host.textContent).not.toContain("current account result");expect(host.textContent).not.toContain("original restored query");
    field("Search screen text","other draft");await act(async()=>{localStorage.setItem("vantyr-server-settings",JSON.stringify({serverOrigin:"https://other.example"}));window.dispatchEvent(new StorageEvent("storage",{key:"vantyr-server-settings"}));});assertDraft("","");
    await act(async()=>finishIdentity({id:"user-b"}));field("Search screen text","logout draft");await act(async()=>window.dispatchEvent(new Event("vantyr-session-expired")));assertDraft("","");expect(button().disabled).toBe(true);
  } finally {await act(async()=>root.unmount());host.remove();localStorage.clear();}
});

it("aborts verification on logout and unmount, ignoring late identity completions",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
  let finish!:(value:{id:string})=>void;
  me.mockReset().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const host=document.createElement("div"),root=createRoot(host);
  function Identity(){return <span>{useRecallPreferenceKey("device") ?? "unverified"}</span>;}
  await act(async()=>root.render(<Identity/>));
  const old=finish,signal=me.mock.calls[0][0] as AbortSignal;
  await act(async()=>window.dispatchEvent(new Event("vantyr-session-expired")));expect(signal.aborted).toBe(true);
  await act(async()=>old({id:"private-user"}));expect(host.textContent).toBe("unverified");
  await act(async()=>window.dispatchEvent(new Event("focus")));const next=finish,nextSignal=me.mock.calls[1][0] as AbortSignal;
  await act(async()=>root.unmount());expect(nextSignal.aborted).toBe(true);
  await act(async()=>next({id:"private-user"}));expect(host.textContent).toBe("");
});

it("keeps the key stable while re-verifying the same user on focus and switches it for a different user",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
  let finish!:(value:{id:string})=>void;
  me.mockReset().mockResolvedValueOnce({id:"user-a"}).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const host=document.createElement("div"),root=createRoot(host);const seen:(string|null)[]=[];
  function Identity(){const key=useRecallPreferenceKey("device");seen.push(key);return <span>{key ?? "unverified"}</span>;}
  try {
    await act(async()=>root.render(<Identity/>));const verified=host.textContent;expect(verified).not.toBe("unverified");
    seen.length=0;
    await act(async()=>window.dispatchEvent(new Event("focus")));expect(host.textContent).toBe(verified);
    await act(async()=>finish({id:"user-a"}));expect(host.textContent).toBe(verified);expect(seen.every(key=>key===verified)).toBe(true);
    await act(async()=>window.dispatchEvent(new Event("focus")));await act(async()=>finish({id:"user-b"}));
    expect(host.textContent).not.toBe(verified);expect(host.textContent).not.toBe("unverified");
  } finally {await act(async()=>root.unmount());}
});
