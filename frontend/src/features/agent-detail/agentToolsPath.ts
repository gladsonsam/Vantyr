import { createContext, useContext } from "react";

/**
 * Where the agent tools live in the address bar. Inside a device page that is
 * `/devices/<key>/agent`; anywhere else it falls back to the legacy `/agents/<id>`, which redirects.
 */
export const AgentToolsPathContext = createContext<string | null>(null);

export function useAgentToolsPath(agentId: string): string {
  return useContext(AgentToolsPathContext) ?? `/agents/${agentId}`;
}
