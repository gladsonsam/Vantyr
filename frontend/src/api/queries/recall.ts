import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const recallKeys = {
  all: ["recall"] as const,
  /** Fleet-wide capture settings. */
  settings: () => [...recallKeys.all, "settings"] as const,
  /** Global / override / effective capture settings for one agent. */
  agentSettings: (agentId: string) => [...agentKeys.agent(agentId), "recall-settings"] as const,
  /** Agents that have any retained Recall history. */
  devices: () => [...recallKeys.all, "devices"] as const,
  /** Per-day frame coverage for one agent, cached per verified viewer scope. */
  days: (agentId: string, viewerScope: string | null | undefined) =>
    [...agentKeys.agent(agentId), "history-days", viewerScope ?? null] as const,
};

export const recallQueries = {
  settings: () =>
    queryOptions({
      queryKey: recallKeys.settings(),
      queryFn: () => api.recallSettingsGet(),
    }),
  devices: () =>
    queryOptions({
      queryKey: recallKeys.devices(),
      queryFn: () => api.historyDevices(),
    }),
  /**
   * Passing the abort signal lets TanStack cancel the request once nothing shows this agent's
   * coverage, so a late answer never lands after the picker switches devices and back.
   */
  days: (agentId: string, viewerScope: string | null | undefined) =>
    queryOptions({
      queryKey: recallKeys.days(agentId, viewerScope),
      queryFn: ({ signal }) => api.historyDays(agentId, {}, signal),
    }),
  agentSettings: (agentId: string) =>
    queryOptions({
      queryKey: recallKeys.agentSettings(agentId),
      queryFn: () => api.agentRecallSettingsGet(agentId),
    }),
};
