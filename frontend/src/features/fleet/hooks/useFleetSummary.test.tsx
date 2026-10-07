// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import type { FleetAgentSummary, FleetSummaryResponse } from "@/api/types";
import { useFleetSummary } from "./useFleetSummary";
import { notifySessionExpired } from "@/api/sessionExpiry";
vi.mock("@/api", () => ({ api: { fleetSummary: vi.fn() } }));
const summary: FleetAgentSummary = {info:null,info_reported_at:null,last_window:null,internet_blocked:false,internet_block_source:null,app_block_enabled_count:0};
const response = (ids: readonly string[]): FleetSummaryResponse => ({agents:Object.fromEntries(ids.map(id=>[id,summary])),missing:[]});
const ids = Array.from({length:501},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`);
let root: Root, host: HTMLDivElement, state: ReturnType<typeof useFleetSummary>;
function Harness({fleet,scope}:{fleet:string[];scope:string|null}) {const value=useFleetSummary(fleet,scope);useEffect(()=>{state=value;},[value]);return null;}
async function render(fleet=ids,scope:string|null="server-user") {await act(async()=>root.render(<Harness fleet={fleet} scope={scope}/>));}
interface Request {ids:readonly string[]; signal?:AbortSignal; resolve:(value:FleetSummaryResponse)=>void; reject:(reason:Error)=>void}
let requests: Request[];
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();vi.useFakeTimers();requests=[];
  vi.mocked(api.fleetSummary).mockReset().mockImplementation((batch,signal)=>new Promise((resolve,reject)=>requests.push({ids:batch,signal,resolve,reject})));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>{root.unmount();for(const request of requests)request.resolve(response(request.ids));});host.remove();vi.useRealTimers();});
async function resolve(request:Request,value=response(request.ids)){await act(async()=>request.resolve(value));}
it("splits 501 IDs into six <=100 batches with only three active requests and no per-agent work",async()=>{
  await render();expect(requests).toHaveLength(3);expect(requests.map(r=>r.ids.length)).toEqual([100,100,100]);
  await resolve(requests[1]);expect(requests).toHaveLength(4);await resolve(requests[0]);await resolve(requests[2]);expect(requests).toHaveLength(6);
  await resolve(requests[3]);await resolve(requests[4]);await resolve(requests[5]);
  expect(requests.map(r=>r.ids.length)).toEqual([100,100,100,100,100,1]);expect(Object.keys(state)).toHaveLength(501);
  expect(new Set(requests.flatMap(r=>[...r.ids])).size).toBe(501);
  await render([...ids].reverse());expect(requests).toHaveLength(6);
});
it("preserves unknown vs known false/zero and fails malformed entries without healthy defaults",async()=>{
  await render(ids.slice(0,3));await resolve(requests[0],{agents:{[ids[0]]:summary},missing:[ids[1]]});
  expect(state[ids[0]]).toEqual({status:"ready",summary});expect(state[ids[1]]).toEqual({status:"missing"});expect(state[ids[2]]).toEqual({status:"error"});
  await act(async()=>vi.advanceTimersByTime(60_000));await act(async()=>requests[1].reject(new Error("DB unavailable")));
  expect(Object.values(state)).toEqual([{status:"error"},{status:"error"},{status:"error"}]);
  await act(async()=>vi.advanceTimersByTime(60_000));await resolve(requests[2],{agents:{[ids[0]]:{...summary,internet_blocked:undefined} as unknown as FleetAgentSummary},missing:[]});
  expect(state[ids[0]]).toEqual({status:"error"});
});
it("invalidates fleet removals and scope changes immediately while retaining a global three-slot bound",async()=>{
  await render();const old=requests.slice();await render(ids.slice(0,1),"other-user");expect(state).toEqual({});expect(requests).toHaveLength(3);expect(old.every(r=>r.signal?.aborted)).toBe(true);
  await resolve(old[0]);expect(requests).toHaveLength(4);expect(state).toEqual({});await resolve(requests[3]);expect(Object.keys(state)).toEqual([ids[0]]);
  await resolve(old[1]);await resolve(old[2]);expect(Object.keys(state)).toEqual([ids[0]]);
  await render([],"other-user");expect(state).toEqual({});expect(requests).toHaveLength(4);
  await render(ids.slice(0,1),null);expect(requests).toHaveLength(4);expect(state).toEqual({});
});
it("discards old-server results even before a parent rerender, and session expiry stops work",async()=>{
  await render(ids.slice(0,1));const old=requests[0];
  localStorage.setItem("vantyr-server-settings",JSON.stringify({serverOrigin:"https://another.example"}));
  await resolve(old);expect(state).toEqual({});
  await act(async()=>window.dispatchEvent(new StorageEvent("storage",{key:"vantyr-server-settings"})));
  expect(requests).toHaveLength(2);await resolve(requests[1]);expect(state[ids[0]].status).toBe("ready");
  await act(async()=>notifySessionExpired());expect(state).toEqual({});
  await act(async()=>vi.advanceTimersByTime(120_000));expect(requests).toHaveLength(2);
  await render(ids.slice(0,1),null);await render(ids.slice(0,1),"new-login");expect(requests).toHaveLength(3);
});
it("aborts timed-out requests and never publishes late success or overlaps polling rounds",async()=>{
  await render(ids.slice(0,1));await act(async()=>vi.advanceTimersByTime(30_000));expect(requests[0].signal?.aborted).toBe(true);
  await act(async()=>vi.advanceTimersByTime(120_000));expect(requests).toHaveLength(1);
  await resolve(requests[0]);expect(state[ids[0]]).toEqual({status:"error"});
  await act(async()=>vi.advanceTimersByTime(59_999));expect(requests).toHaveLength(1);await act(async()=>vi.advanceTimersByTime(1));expect(requests).toHaveLength(2);
});
