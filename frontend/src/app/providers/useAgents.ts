import { createContext, useContext } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "@/api/types";

export interface AgentsContextValue {
  agents: Record<string, Agent>;
  liveStatus: Record<string, AgentLiveStatus>;
  agentInfo: Record<string, AgentInfo | null>;
  agentInfoReceivedAtMs: Record<string, number>;
  /** True once the WebSocket `init` snapshot has arrived for this session. */
  initialized: boolean;
  setSelectedAgentId: (id: string | null) => void;
  /** Send a message over the dashboard WebSocket. */
  send: (msg: unknown) => void;
  /** Re-check auth and refetch agents plus their last-known telemetry, like a browser reload. */
  refresh: () => Promise<void>;
}

export const AgentsContext = createContext<AgentsContextValue | null>(null);

/** Live fleet state fed by the dashboard WebSocket and a background poll. */
export function useAgents(): AgentsContextValue {
  const value = useContext(AgentsContext);
  if (!value) throw new Error("useAgents must be used inside AgentsProvider");
  return value;
}
