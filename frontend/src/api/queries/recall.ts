import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const recallKeys = {
  all: ["recall"] as const,
  /** Fleet-wide capture settings. */
  settings: () => [...recallKeys.all, "settings"] as const,
  /** Global / override / effective capture settings for one agent. */
  agentSettings: (agentId: string) => [...agentKeys.agent(agentId), "recall-settings"] as const,
};

export const recallQueries = {
  settings: () =>
    queryOptions({
      queryKey: recallKeys.settings(),
      queryFn: () => api.recallSettingsGet(),
    }),
  agentSettings: (agentId: string) =>
    queryOptions({
      queryKey: recallKeys.agentSettings(agentId),
      queryFn: () => api.agentRecallSettingsGet(agentId),
    }),
};
