import { afterEach, expect, it, vi } from "vitest";
import { realApi } from "@/api";
import { createDemoApi } from "@/demo/api";
import { demoAgents, demoAppBlockRules } from "@/demo/data";

afterEach(()=>{vi.unstubAllGlobals();localStorage.clear();});
it("uses the authenticated fleet endpoint with encoded IDs, cancellation, and an exact batch response",async()=>{
  localStorage.setItem("vantyr-server-settings",JSON.stringify({serverOrigin:"https://fleet.example",apiPrefix:"/dashboard/api"}));
  const body={agents:{},missing:["00000000-0000-4000-8000-000000000001"]};
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetcher);
  const controller=new AbortController(),id=body.missing[0];expect(await realApi.fleetSummary([id,id],controller.signal)).toEqual(body);
  const [url,init]=fetcher.mock.calls[0];expect(new URL(url).pathname).toBe("/dashboard/api/agents/fleet-summary");expect(new URL(url).searchParams.get("ids")).toBe(id);
  expect(init).toMatchObject({method:"GET",credentials:"include",signal:controller.signal});
  await expect(realApi.fleetSummary([])).rejects.toThrow();await expect(realApi.fleetSummary(Array.from({length:101},(_,i)=>String(i)))).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
});
it("propagates whole-request server errors without healthy policy defaults",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"Query failed"}),{status:500,headers:{"Content-Type":"application/json"}})));
  await expect(realApi.fleetSummary(["00000000-0000-4000-8000-000000000001"])).rejects.toThrow("Query failed");
});
it("demo batches deduplicate, return only requested existing IDs and honor removed IDs and shared configuration",async()=>{
  const demo=createDemoApi(realApi), id=demoAgents[0].id;
  const first=await demo.fleetSummary([id,"unknown",id]);expect(Object.keys(first.agents)).toEqual([id]);expect(first.missing).toEqual(["unknown"]);
  expect(first.agents[id].app_block_enabled_count).toBe(new Set(demoAppBlockRules.filter(rule=>rule.enabled).map(rule=>rule.id)).size);
  expect(first.agents[id].info_reported_at).toBeTruthy();expect(first.agents[id].last_window?.reported_at).toBeTruthy();
  const blocked=await demo.fleetSummary(["sitting-room"]);expect(blocked.agents["sitting-room"]).toMatchObject({internet_blocked:true,internet_block_source:"agent"});
  await demo.agentInternetBlockedPut(id,{blocked:true});expect((await demo.fleetSummary([id])).agents[id]).toMatchObject({internet_blocked:true,internet_block_source:"agent"});
  await demo.deleteAgents([id]);const removed=await demo.fleetSummary([id,"unknown"]);expect(removed.agents).toEqual({});expect(removed.missing).toEqual([id,"unknown"].sort());
  await expect(demo.fleetSummary([])).rejects.toThrow();
});
