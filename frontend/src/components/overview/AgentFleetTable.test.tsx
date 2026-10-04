// @vitest-environment jsdom
import type { Agent, AgentInfo, FleetSummaryResponse } from "../../lib/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFleetTable } from "./AgentFleetTable";
import { OverviewPage } from "../../pages/OverviewPage";
import { useAgents } from "../../hooks/useAgents";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ apiUrl: (path: string) => path, api: {
  fleetSummary: vi.fn().mockImplementation(async (ids: string[]) => ({agents: Object.fromEntries(ids.map(id => [id, {info:null,info_reported_at:null,last_window:null,internet_blocked:true,internet_block_source:"agent",app_block_enabled_count:0}])), missing:[]})),
  windows: vi.fn().mockResolvedValue({ rows: [] }),
  agentInfo: vi.fn().mockResolvedValue({ info: null }),
  agentInternetBlockedGet: vi.fn().mockResolvedValue({ blocked: true }),
  appBlockRulesList: vi.fn().mockResolvedValue({ rules: [] }),
  deleteAgents: vi.fn(),
} }));
vi.mock("../../lib/serverVersionStore", () => ({ useServerVersionPayload: () => null }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("./AddAgentModal", () => ({ AddAgentModal: () => null }));

const agent: Agent = { id: "pc", name: "Office PC", online: false, last_seen: "2026-01-01", first_seen: "2026-01-01", connected_at: null, last_connected_at: null, last_disconnected_at: null };
const props = {
  preferenceScope: "test-user-server",
  agents: { pc: agent }, liveStatus: {}, agentInfo: {}, agentInfoReceivedAtMs: {},
  onSelectAgent: vi.fn(), onOpenScreen: vi.fn(), onRefresh: vi.fn(),
  onBatchWake: vi.fn(), onBulkScript: vi.fn(), onBatchLock: vi.fn(),
  onBatchRestart: vi.fn(), onBatchShutdown: vi.fn(),
};
let sidebar: ReturnType<typeof useAgents>;
function SidebarProbe() {
  sidebar = useAgents();
  return <div data-testid="sidebar">{sidebar.agentList.map((a) => a.id).join(",")}</div>;
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.fleetSummary).mockImplementation(async ids => ({agents:Object.fromEntries(ids.map(id=>[id,{info:null,info_reported_at:null,last_window:null,internet_blocked:true,internet_block_source:"agent" as const,app_block_enabled_count:0}])),missing:[]}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label && !b.disabled);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

describe("fleet removal", () => {
  it("shares sorting with the sidebar and clears a removed device's cached state and selection", async () => {
    await act(async () => root.render(<><AgentFleetTable {...props} /><SidebarProbe /></>));
    await act(async () => {
      sidebar.setAllAgents({ pc: agent, online: { ...agent, id: "online", name: "Z PC", online: true } });
      sidebar.setSelectedAgentId("pc");
      sidebar.updateAgentInfo("pc", null);
      sidebar.updateAgentLiveStatus("pc", { activity: "afk" });
    });
    expect(container.querySelector('[data-testid="sidebar"]')?.textContent).toBe("online,pc");
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Sort devices"]')!;
    await act(async () => { select.value = "name"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector('[data-testid="sidebar"]')?.textContent).toBe("pc,online");
    await act(async () => sidebar.removeAgent("pc"));
    expect(sidebar.selectedAgentId).toBeNull();
    expect(sidebar.agents.pc).toBeUndefined();
    expect(sidebar.liveStatus.pc).toBeUndefined();
    expect(sidebar.agentInfo.pc).toBeUndefined();
    expect(sidebar.agentInfoReceivedAtMs.pc).toBeUndefined();
  });
  for (const mode of ["grid", "table"] as const) {
    it(`requires named confirmation in ${mode} and retains it on failure until retry succeeds`, async () => {
      let reject!: (reason: Error) => void;
      const remove = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
      await act(async () => root.render(<AgentFleetTable {...props} controlledViewMode={mode} onDeleteAgents={remove} />));
      expect(container.textContent).toContain("Offline");
      expect(container.textContent).toContain("Internet block configured");
      await click("Remove device…");
      expect(remove).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Affected: Office PC");
      await click("Remove devices");
      expect(remove).toHaveBeenCalledWith(["pc"]);
      expect(props.onRefresh).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Affected: Office PC");
      await act(async () => reject(new Error("Removal denied")));
      expect(document.querySelector('[role="alert"]')?.textContent).toBe("Removal denied");
      await click("Remove devices");
      expect(props.onRefresh).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).not.toContain("Affected:");
    });
  }
  it("OverviewPage propagates API rejection and preserves bulk selection", async () => {
    vi.mocked(api.deleteAgents).mockRejectedValue(new Error("Server unavailable"));
    await act(async () => root.render(<OverviewPage {...props} loadingAgents={false} showAddAgent />));
    await click("Select all");
    await click("Remove devices (1)");
    await click("Remove devices");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Server unavailable");
    expect(container.textContent).toContain("1 selected");
    expect(props.onRefresh).not.toHaveBeenCalled();
  });
  it("saves sorting across views and remounts", async () => {
    await act(async () => root.render(<AgentFleetTable {...props} controlledViewMode="grid" />));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Sort devices"]')!;
    await act(async () => { select.value = "name"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => root.render(<AgentFleetTable {...props} controlledViewMode="table" />));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Sort devices"]')?.value).toBe("name");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AgentFleetTable {...props} />));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Sort devices"]')?.value).toBe("name");
  });
});

const stored: FleetSummaryResponse = {agents:{pc:{info:{hostname:"Stored host",current_user:"Stored user",uptime_secs:120},info_reported_at:"2026-01-01T00:00:00Z",last_window:{app:"old.exe",title:"Historical window",reported_at:"2026-01-01T00:00:00Z"},internet_blocked:false,internet_block_source:null,app_block_enabled_count:0}},missing:[]};
it("enriches by fleet batch, keeps live events ahead of late history and does not refetch on live updates or search",async()=>{
  let resolve!: (value:FleetSummaryResponse)=>void;vi.mocked(api.fleetSummary).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  await act(async()=>root.render(<AgentFleetTable {...props}/>));
  await act(async()=>root.render(<AgentFleetTable {...props} agentInfo={{pc:{current_user:"Live user",uptime_secs:60} as AgentInfo}} agentInfoReceivedAtMs={{pc:Date.now()}} liveStatus={{pc:{activity:"active",window:"Live window",app:"live.exe"}}}/>));
  await act(async()=>resolve(stored));expect(container.textContent).toContain("Live window");expect(container.textContent).toContain("Live user");expect(container.textContent).not.toContain("Historical window");expect(container.textContent).not.toContain("Stored user");
  expect(container.textContent).toContain("No always-on internet block");expect(container.textContent).toContain("Enabled app rules: 0");
  await act(async()=>root.render(<AgentFleetTable {...props} controlledQuery="Office" liveStatus={{pc:{window:"Updated live window"}}}/>));
  expect(container.textContent).toContain("Updated live window");expect(api.fleetSummary).toHaveBeenCalledTimes(1);
  expect(api.windows).not.toHaveBeenCalled();expect(api.agentInfo).not.toHaveBeenCalled();expect(api.agentInternetBlockedGet).not.toHaveBeenCalled();expect(api.appBlockRulesList).not.toHaveBeenCalled();
});
it.each(["grid","table"] as const)("shows history and unknown policy truthfully in %s; omitted/error results never look like false/zero",async mode=>{
  vi.mocked(api.fleetSummary).mockResolvedValueOnce(stored);
  await act(async()=>root.render(<AgentFleetTable {...props} controlledViewMode={mode}/>));expect(container.textContent).toContain("Historical window");expect(container.querySelector('[title^="Stored window history"]')).not.toBeNull();
  vi.mocked(api.fleetSummary).mockResolvedValueOnce({agents:{},missing:["pc"]});
  await act(async()=>root.render(<AgentFleetTable {...props} preferenceScope="other-user" controlledViewMode={mode}/>));
  expect(container.textContent).toContain("Device absent from fleet summary");expect(container.textContent).not.toContain("No always-on internet block");expect(container.textContent).not.toContain("Enabled app rules: 0");expect(container.textContent).not.toContain("Historical window");
  vi.mocked(api.fleetSummary).mockRejectedValueOnce(new Error("DB failed"));
  await act(async()=>root.render(<AgentFleetTable {...props} preferenceScope="other-server" controlledViewMode={mode}/>));expect(container.textContent).toContain("Policy configuration unavailable");expect(container.textContent).not.toContain("Enabled app rules: 0");
});
