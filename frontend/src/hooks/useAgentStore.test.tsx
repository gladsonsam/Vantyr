// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/api/types";
import { useAgentStore } from "./useAgentStore";

vi.mock("@/lib/fleetSort", () => ({ useFleetSort: () => ["name"], sortFleet: (agents: Agent[]) => agents }));

describe("useAgentStore lifecycle", () => {
  it("clears every cache and selection, and ignores late snapshots and telemetry after removal", async () => {
    let state!: ReturnType<typeof useAgentStore>;
    function Harness() { state = useAgentStore(); return null; }
    const element = document.createElement("div");
    const root = createRoot(element);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await act(async () => root.render(<Harness />));
    const agent = { id: "a", name: "device", online: true } as Agent;
    await act(async () => {
      state.updateAgent("a", agent);
      state.updateAgentLiveStatus("a", { window: "old" });
      state.updateAgentInfo("a", { hostname: "old" });
      state.setSelectedAgentId("a");
    });
    await act(async () => state.removeAgent("a"));
    expect(state.agents).toEqual({});
    expect(state.liveStatus).toEqual({});
    expect(state.agentInfo).toEqual({});
    expect(state.agentInfoReceivedAtMs).toEqual({});
    expect(state.selectedAgentId).toBeNull();
    await act(async () => {
      state.setAllAgents({ a: agent });
      state.updateAgent("a", agent);
      state.updateAgentInfo("a", { hostname: "late" });
      state.updateAgentLiveStatus("a", { window: "late" });
    });
    expect(state.agents).toEqual({});
    expect(state.liveStatus).toEqual({});
    expect(state.agentInfo).toEqual({});
    await act(async () => root.unmount());
  });

  it("an empty authoritative fleet clears stale caches", async () => {
    let state!: ReturnType<typeof useAgentStore>;
    function Harness() { state = useAgentStore(); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => {
      state.updateAgent("a", { id: "a", name: "device", online: false } as Agent);
      state.updateAgentInfo("a", { hostname: "old" });
      state.updateAgentLiveStatus("a", { window: "old" });
      state.setSelectedAgentId("a");
    });
    await act(async () => state.setAllAgents({}));
    expect(state.agents).toEqual({});
    expect(state.agentInfo).toEqual({});
    expect(state.liveStatus).toEqual({});
    expect(state.selectedAgentId).toBeNull();
    await act(async () => root.unmount());
  });
});
