import { createContext, useContext } from "react";

/** Where the agent tools live in the address bar: `/devices/<key>/agent`. Set by the device's Agent tab. */
export const AgentToolsPathContext = createContext<string | null>(null);

/** The tools path; only valid inside the device's Agent tab. */
export function useAgentToolsPath(): string {
  const path = useContext(AgentToolsPathContext);
  if (path === null) throw new Error("useAgentToolsPath must be used inside the device Agent tab");
  return path;
}
