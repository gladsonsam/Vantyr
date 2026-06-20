import { useState, useCallback } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "../lib/types";
import { mergeLiveStatus } from "../lib/live-status";

export function useAgents() {
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
      setLiveStatus((prev) => ({ ...prev, [id]: mergeLiveStatus(prev[id], patch) }));
    },
    [],
  );

  const updateAgentInfo = useCallback((id: string, info: AgentInfo | null) => {
    setAgentInfo((prev) => ({ ...prev, [id]: info }));
    setAgentInfoReceivedAtMs((prev) => ({ ...prev, [id]: Date.now() }));
  }, []);

  const removeAgent = useCallback((id: string) => {
    setAgents((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
    setLiveStatus((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
    setAgentInfo((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
    setAgentInfoReceivedAtMs((prev) => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
  }, []);

  const setAllAgents = useCallback((newAgents: Record<string, Agent>) => {
    setAgents(newAgents);
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

  const agentList = Object.values(agents).sort((a, b) => {
    if (a.online !== b.online) return b.online ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

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
