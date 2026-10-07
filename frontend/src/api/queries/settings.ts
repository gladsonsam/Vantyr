import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const settingsKeys = {
  all: ["settings"] as const,
  capabilities: () => [...settingsKeys.all, "capabilities"] as const,
  retention: () => [...settingsKeys.all, "retention"] as const,
  storage: () => [...settingsKeys.all, "storage"] as const,
  autoUpdate: () => [...settingsKeys.all, "agent-auto-update"] as const,
  /** Background poll of `/settings/version` that feeds the app-wide server version store. */
  versionPoll: () => [...settingsKeys.all, "version", "poll"] as const,
  /** The Settings page's own "latest release" check (can bypass the server's GitHub cache). */
  releaseCheck: () => [...settingsKeys.all, "version", "release-check"] as const,
  agentRetention: (agentId: string) => [...agentKeys.agent(agentId), "retention"] as const,
  agentAutoUpdate: (agentId: string) => [...agentKeys.agent(agentId), "auto-update"] as const,
  agentLocalUiPassword: (agentId: string) => [...agentKeys.agent(agentId), "local-ui-password"] as const,
};

export const settingsQueries = {
  /** Server feature switches (remote scripts allowed, scheduler timezone). */
  capabilities: () =>
    queryOptions({
      queryKey: settingsKeys.capabilities(),
      queryFn: () => api.capabilities(),
    }),
  retention: () =>
    queryOptions({
      queryKey: settingsKeys.retention(),
      queryFn: () => api.retentionGlobalGet(),
    }),
  storage: () =>
    queryOptions({
      queryKey: settingsKeys.storage(),
      queryFn: () => api.storageUsage(),
    }),
  autoUpdate: () =>
    queryOptions({
      queryKey: settingsKeys.autoUpdate(),
      queryFn: () => api.agentAutoUpdateGlobalGet(),
    }),
  versionPoll: () =>
    queryOptions({
      queryKey: settingsKeys.versionPoll(),
      queryFn: () => api.settingsVersionGet(),
    }),
  releaseCheck: (nocache = false) =>
    queryOptions({
      queryKey: settingsKeys.releaseCheck(),
      queryFn: () => api.settingsVersionGet({ nocache }),
    }),
  agentRetention: (agentId: string) =>
    queryOptions({
      queryKey: settingsKeys.agentRetention(agentId),
      queryFn: () => api.retentionAgentGet(agentId),
    }),
  agentAutoUpdate: (agentId: string) =>
    queryOptions({
      queryKey: settingsKeys.agentAutoUpdate(agentId),
      queryFn: () => api.agentAutoUpdateAgentGet(agentId),
    }),
  agentLocalUiPassword: (agentId: string) =>
    queryOptions({
      queryKey: settingsKeys.agentLocalUiPassword(agentId),
      queryFn: () => api.localUiPasswordAgentGet(agentId),
    }),
};
