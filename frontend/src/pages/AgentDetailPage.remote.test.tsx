import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentDetailPage } from "./AgentDetailPage";
import { demoAgents } from "@/demo/data";

const backend=vi.hoisted(()=>({me:vi.fn(),agentModules:vi.fn(),agentClipboard:vi.fn()}));
vi.mock("@/api",()=>({api:backend,isApiError:()=>false,apiUrl:(path:string)=>path,mjpegStreamUrl:(id:string,session:string)=>`https://server.example/mjpeg?agent=${id}&session=${session}`,notifyMjpegViewerLeft:vi.fn()}));
vi.mock("@/demo/mode",()=>({isDemoMode:true}));
vi.mock("@/demo/fakeScreen",()=>({DemoScreen:()=>null}));
vi.mock("@/components/detail/AgentDetailTabContent",()=>({AgentDetailTabContent:()=>null}));
vi.mock("@/components/detail/AgentVitals",()=>({AgentVitals:()=>null}));
vi.mock("@/hooks/useResolvedAgentInfo",()=>({useResolvedAgentInfo:()=>({resolvedInfo:{capabilities:{remote_input:"supported",clipboard:"supported"}}})}));
vi.mock("@/hooks/useAgentActivitySessions",()=>({useAgentActivitySessions:()=>({sessions:[],loading:false,loadingMore:false,hasMoreOlder:false,loadMoreOlderActivity:vi.fn(),loadActivityData:vi.fn()})}));
let host:HTMLDivElement,root:Root;const send=vi.fn(),noop=vi.fn();
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();send.mockClear();
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  backend.me.mockResolvedValue({id:"a",role:"operator"});backend.agentModules.mockResolvedValue({online:true,state:{modules:[{module:"clipboard",available:true,enabled:true,authorization_required:false}]}});
  backend.agentClipboard.mockResolvedValue({ok:true,text:"account-a text"});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
async function render(account="a"){
  const agent=demoAgents.find(a=>a.online)!;
  await act(async()=>root.render(<MemoryRouter><AgentDetailPage agent={agent} agents={{[agent.id]:agent}} agentInfo={null} agentInfoById={{}} liveStatusById={{}} sendWsMessage={send} onNotifyInfo={noop} onNotifyWarning={noop} onNotifyError={noop} activeTab="live" onTabChange={noop} onSelectAgent={noop} dashboardRole="operator" dashboardAccountId={account}/></MemoryRouter>));
}
async function click(label:string){await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent?.trim()===label)!.click());}
it("keeps control across parent uptime rerenders and redundant visibility events, but immediately remounts/clears it when the account changes",async()=>{
  await render();await click("Take control");const request=send.mock.calls.find(call=>call[0].type==="control_acquire")![0];
  await act(async()=>window.dispatchEvent(new CustomEvent("vantyr-ws-event",{detail:{event:"control_lease",agent_id:request.agent_id,request_id:request.request_id,status:"granted",lease_token:"test-lease",expires_in_ms:15000}})));
  const session=host.querySelector("img")!.src;
  await act(async()=>{vi.advanceTimersByTime(2000);document.dispatchEvent(new Event("visibilitychange"));});
  expect(host.querySelector('[role="application"]')).not.toBeNull();expect(host.querySelector("img")!.src).toBe(session);expect(send.mock.calls.some(call=>call[0].type==="control_release")).toBe(false);
  await click("More tools");
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>(".remote-tool-group-toggle")].find(b=>b.textContent?.startsWith("Text clipboard"))!.click());const field=host.querySelector<HTMLTextAreaElement>('[aria-label="Text to send to device clipboard"]')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,"account-a draft");field.dispatchEvent(new Event("input",{bubbles:true}));});
  await click("Fetch from device");expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Device clipboard text"]')!.value).toBe("account-a text");
  backend.me.mockResolvedValue({id:"b",role:"operator"});await render("b");
  expect(host.querySelector('[role="application"]')).toBeNull();expect(host.querySelector("textarea")).toBeNull();
  expect(send.mock.calls.some(call=>call[0].type==="control_release"&&call[0].lease_token==="test-lease")).toBe(true);expect(host.querySelector("img")!.src).not.toBe(session);
});
