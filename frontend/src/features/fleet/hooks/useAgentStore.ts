import { useState, useCallback, useRef } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "@/api/types";
import { sortFleet, useFleetSort } from "@/features/fleet/lib/fleetSort";
import { mergeLiveStatus } from "@/features/fleet/lib/liveStatus";

import { withoutAgent, retainAgents } from "@/features/fleet/lib/agentLifecycle";

export function useAgentStore() {
  const removedIds = useRef(new Set<string>());
  const [fleetSort] = useFleetSort();
  const [agents, setAgents] = useState<Record<string, Agent>>({});
  const [liveStatus, setLiveStatus] = useState<Record<string, AgentLiveStatus>>({});
  const [agentInfo, setAgentInfo] = useState<Record<string, AgentInfo | null>>({});
  const [agentInfoReceivedAtMs, setAgentInfoReceivedAtMs] = useState<Record<string, number>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Accepts a full agent or a functional updater so callers can merge over the latest state
  // (rather than a stale render snapshot). An updater returning `undefined` is a no-op.
  const updateAgent = useCallback(
    (
      id: string,
      update: Agent | ((prev: Agent | undefined) => Agent | undefined),
    ) => {
      if (removedIds.current.has(id)) return;
      setAgents((prev) => {
        const next = typeof update === "function" ? update(prev[id]) : update;
        if (!next) return prev;
        return { ...prev, [id]: next };
      });
    },
    [],
  );

  // Merge a partial patch onto the latest snapshot so bursty events don't clobber each other.
  const updateAgentLiveStatus = useCallback(
    (id: string, patch: Partial<AgentLiveStatus>) => {
      if (removedIds.current.has(id)) return;
      setLiveStatus((prev) => ({ ...prev, [id]: mergeLiveStatus(prev[id], patch) }));
    },
    [],
  );

  const updateAgentInfo = useCallback((id: string, info: AgentInfo | null) => {
    if (removedIds.current.has(id)) return;
    setAgentInfo((prev) => ({ ...prev, [id]: info }));
    setAgentInfoReceivedAtMs((prev) => ({ ...prev, [id]: Date.now() }));
  }, []);

  const removeAgent = useCallback((id: string) => {
    // Late HTTP snapshots and telemetry must not resurrect a deleted UUID.
    removedIds.current.add(id);
    setSelectedAgentId((prev) => prev === id ? null : prev);
    setAgents((prev) => withoutAgent(prev, id));
    setLiveStatus((prev) => withoutAgent(prev, id));
    setAgentInfo((prev) => withoutAgent(prev, id));
    setAgentInfoReceivedAtMs((prev) => withoutAgent(prev, id));
  }, []);

  const setAllAgents = useCallback((newAgents: Record<string, Agent>) => {
    const next = Object.fromEntries(Object.entries(newAgents).filter(([id]) => !removedIds.current.has(id)));
    const ids = new Set(Object.keys(next));
    setAgents(next);
    setLiveStatus((prev) => retainAgents(prev, ids));
    setAgentInfo((prev) => retainAgents(prev, ids));
    setAgentInfoReceivedAtMs((prev) => retainAgents(prev, ids));
    setSelectedAgentId((prev) => prev && ids.has(prev) ? prev : null);
  }, []);

  const getAgent = useCallback(
    (id: string) => agents[id] || null,
    [agents]
  );

  const getAgentLiveStatus = useCallback(
    (id: string) => liveStatus[id] || null,
    [liveStatus]
  );

  const getAgentInfo = useCallback(
    (id: string) => agentInfo[id] || null,
    [agentInfo]
  );

  const selectedAgent = selectedAgentId ? agents[selectedAgentId] : null;

  const agentList = sortFleet(Object.values(agents), fleetSort);

  return {
    agents,
    liveStatus,
    agentInfo,
    agentInfoReceivedAtMs,
    selectedAgentId,
    selectedAgent,
    agentList,
    updateAgent,
    updateAgentLiveStatus,
    updateAgentInfo,
    removeAgent,
    setAllAgents,
    setSelectedAgentId,
    getAgent,
    getAgentLiveStatus,
    getAgentInfo,
  };
}
