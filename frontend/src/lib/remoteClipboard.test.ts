import { afterEach, expect, it, vi } from "vitest";
import { realApi, setDashboardCsrfToken } from "@/api";
import { clipboardTextFits } from "./remoteClipboard";
import { createDemoApi } from "@/demo/api";
import { demoAgents } from "@/demo/data";

afterEach(()=>{setDashboardCsrfToken(null);vi.unstubAllGlobals();});
it("posts the clipboard action and control token as credentialed CSRF JSON with an abort signal",async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({ok:true,text:"日本😀"}),{headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetcher);setDashboardCsrfToken("test-csrf");const controller=new AbortController();
  expect(await realApi.agentClipboard("device",{action:"read",control_token:"active-lease"},controller.signal)).toEqual({ok:true,text:"日本😀"});
  const [url,init]=fetcher.mock.calls[0];expect(url).toContain("/agents/device/clipboard");expect(init).toMatchObject({method:"POST",credentials:"include",signal:controller.signal,headers:{"Content-Type":"application/json","X-CSRF-Token":"test-csrf"}});
  expect(JSON.parse(init.body)).toEqual({action:"read",control_token:"active-lease"});
  await realApi.agentClipboard("device",{action:"write",control_token:"active-lease",text:"日本😀"});expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({action:"write",control_token:"active-lease",text:"日本😀"});
});
it("measures the text limit in UTF-8 bytes rather than JavaScript code units",()=>{
  expect(clipboardTextFits("😀".repeat(16384))).toBe(true);expect(clipboardTextFits("😀".repeat(16384)+"a")).toBe(false);
  expect(clipboardTextFits("a".repeat(65536))).toBe(true);expect(clipboardTextFits("a".repeat(65537))).toBe(false);
});
it("demo clipboard is a per-device ephemeral simulation, respects permission/limit and never calls the real backend",async()=>{
  const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);const demo=createDemoApi(realApi);const online=demoAgents.filter(a=>a.online);
  const first=online[0].id,second=online[1].id;
  expect(await demo.agentClipboard(first,{action:"read",control_token:"demo-lease"})).toEqual({ok:true,text:"Simulated device clipboard text"});
  await demo.agentClipboard(first,{action:"write",control_token:"demo-lease",text:"demo 日本😀"});
  expect(await demo.agentClipboard(first,{action:"read",control_token:"demo-lease"})).toEqual({ok:true,text:"demo 日本😀"});
  expect(await demo.agentClipboard(second,{action:"read",control_token:"demo-lease"})).toEqual({ok:true,text:"Simulated device clipboard text"});
  await expect(demo.agentClipboard(first,{action:"write",control_token:"demo-lease",text:"😀".repeat(16385)})).rejects.toThrow("64 KiB");
  const modules=await demo.agentModules(first),grant=modules.state!.modules.find(m=>m.module==="clipboard")!;
  await demo.disableAgentModule(first,{module:"clipboard",expected_revision:grant.revision,command_id:"disable"});
  await expect(demo.agentClipboard(first,{action:"read",control_token:"demo-lease"})).rejects.toThrow("permission");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await createDemoApi(realApi).agentClipboard(first,{action:"read",control_token:"demo-lease"})).toEqual({ok:true,text:"Simulated device clipboard text"});
});
