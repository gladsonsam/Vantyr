import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const moduleKeys = {
  /** Device module grants, the latest report and pending stop requests for one agent. */
  status: (agentId: string) => [...agentKeys.agent(agentId), "modules"] as const,
};

export const moduleQueries = {
  status: (agentId: string) =>
    queryOptions({
      queryKey: moduleKeys.status(agentId),
      queryFn: () => api.agentModules(agentId),
    }),
};
