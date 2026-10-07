import type { LocalUiPasswordAgentState, LocalUiPasswordGlobalState, RetentionPolicy, StorageUsage } from "@/api/types";
import { get, putJson, postEmpty, delJson } from "@/api/client";
import { publishServerVersion, type SettingsVersionPayload } from "@/api/serverVersionStore";

export const settingsEndpoints = {
  // ── Retention (server) ───────────────────────────────────────────────────

  retentionGlobalGet: (): Promise<RetentionPolicy> => get("/settings/retention"),

  retentionGlobalPut: (body: RetentionPolicy): Promise<RetentionPolicy> =>
    putJson("/settings/retention", body),

  retentionAgentGet: (
    id: string,
  ): Promise<{ global: RetentionPolicy; override: RetentionPolicy | null }> =>
    get(`/agents/${id}/retention`),

  retentionAgentPut: (
    id: string,
    body: RetentionPolicy,
  ): Promise<{ global: RetentionPolicy; override: RetentionPolicy | null }> =>
    putJson(`/agents/${id}/retention`, body),

  retentionAgentDelete: (
    id: string,
  ): Promise<{ global: RetentionPolicy; override: RetentionPolicy | null }> =>
    delJson(`/agents/${id}/retention`),

  // ── Agent local settings window password (pushed to Windows agents) ───────

  localUiPasswordGlobalGet: (): Promise<LocalUiPasswordGlobalState> =>
    get("/settings/local-ui-password"),

  localUiPasswordGlobalPut: (body: {
    password: string | null;
  }): Promise<LocalUiPasswordGlobalState> =>
    putJson("/settings/local-ui-password", body),

  localUiPasswordAgentGet: (
    id: string,
  ): Promise<LocalUiPasswordAgentState> =>
    get(`/agents/${id}/local-ui-password`),

  localUiPasswordAgentPut: (
    id: string,
    body: { password: string | null },
  ): Promise<LocalUiPasswordAgentState> =>
    putJson(`/agents/${id}/local-ui-password`, body),

  localUiPasswordAgentDelete: (
    id: string,
  ): Promise<LocalUiPasswordAgentState> =>
    delJson(`/agents/${id}/local-ui-password`),

  // ── Agent auto-update policy (pushed to Windows agents) ────────────────────

  agentAutoUpdateGlobalGet: (): Promise<{ enabled: boolean }> =>
    get("/settings/agent-auto-update"),

  agentAutoUpdateGlobalPut: (body: { enabled: boolean }): Promise<{ enabled: boolean }> =>
    putJson("/settings/agent-auto-update", body),

  agentAutoUpdateAgentGet: (
    id: string,
  ): Promise<{ global: { enabled: boolean }; override: { enabled: boolean } | null }> =>
    get(`/agents/${id}/auto-update`),

  agentAutoUpdateAgentPut: (
    id: string,
    body: { enabled: boolean },
  ): Promise<{ global: { enabled: boolean }; override: { enabled: boolean } | null }> =>
    putJson(`/agents/${id}/auto-update`, body),

  agentAutoUpdateAgentDelete: (
    id: string,
  ): Promise<{ global: { enabled: boolean }; override: { enabled: boolean } | null }> =>
    delJson(`/agents/${id}/auto-update`),

  agentUpdateNow: (id: string): Promise<{ ok: boolean }> =>
    postEmpty(`/agents/${id}/update-now`),

  settingsVersionGet: async (opts?: { nocache?: boolean }): Promise<SettingsVersionPayload> => {
    const qs = opts?.nocache ? "?nocache=true" : "";
    const result = await get<SettingsVersionPayload>(`/settings/version${qs}`);
    publishServerVersion(result);
    return result;
  },

  storageUsage: (): Promise<StorageUsage> => get("/settings/storage"),

  capabilities: (): Promise<{ remote_script: boolean; scheduler_timezone?: string }> =>
    get("/settings/capabilities"),
};

/** How often the UI should call `settingsVersionGet` (server caches GitHub for a similar window). */
export const SETTINGS_VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;
