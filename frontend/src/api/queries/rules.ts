import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const ruleKeys = {
  /** Effective internet block for one agent (manual toggle or a matching rule). */
  internetBlocked: (agentId: string) => [...agentKeys.agent(agentId), "internet-blocked"] as const,
};

export const ruleQueries = {
  internetBlocked: (agentId: string) =>
    queryOptions({
      queryKey: ruleKeys.internetBlocked(agentId),
      queryFn: () => api.agentInternetBlockedGet(agentId),
    }),
};
