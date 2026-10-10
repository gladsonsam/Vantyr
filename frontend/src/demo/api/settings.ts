import type { ApiClient } from "@/api";
import { publishServerVersion } from "@/api/serverVersionStore";
import { asRecord } from "./helpers";

/** Fake retention, local UI password, auto-update and server capabilities endpoints. */
export function demoSettingsApi(): Partial<ApiClient> {
  return {
    retentionGlobalGet: async () => ({ keylog_days: 14, window_days: 30, url_days: 30 }),
    retentionGlobalPut: async (body) => body,
    retentionAgentGet: async () => ({
      global: { keylog_days: 14, window_days: 30, url_days: 30 },
      override: null,
    }),
    retentionAgentPut: async (_id, body) => ({
      global: { keylog_days: 14, window_days: 30, url_days: 30 },
      override: body,
    }),
    retentionAgentDelete: async () => ({
      global: { keylog_days: 14, window_days: 30, url_days: 30 },
      override: null,
    }),
    localUiPasswordGlobalGet: async () => ({ password_set: true }),
    localUiPasswordGlobalPut: async (body) => ({ password_set: Boolean(asRecord(body).password) }),
    localUiPasswordAgentGet: async () => ({ global: { password_set: true }, override: null }),
    localUiPasswordAgentPut: async (_id, body) => ({
      global: { password_set: true },
      override: { password_set: Boolean(asRecord(body).password) },
    }),
    localUiPasswordAgentDelete: async () => ({ global: { password_set: true }, override: null }),
    agentAutoUpdateGlobalGet: async () => ({ enabled: true }),
    agentAutoUpdateGlobalPut: async (body) => ({ enabled: Boolean(asRecord(body).enabled) }),
    agentAutoUpdateAgentGet: async () => ({ global: { enabled: true }, override: null }),
    agentAutoUpdateAgentPut: async (_id, body) => ({
      global: { enabled: true },
      override: { enabled: Boolean(asRecord(body).enabled) },
    }),
    agentAutoUpdateAgentDelete: async () => ({ global: { enabled: true }, override: null }),
    agentUpdateNow: async () => ({ ok: true }),
    settingsVersionGet: async () => {
      const result = {
        server_version: "0.2.9-demo",
        latest_server_release: "0.2.9",
        server_update_available: false,
        latest_agent_version: "0.2.9",
        releases_url: "https://github.com/",
      };
      publishServerVersion(result);
      return result;
    },
    storageUsage: async () => ({
      database_bytes: 512 * 1024 * 1024,
      public_tables_bytes: 410 * 1024 * 1024,
      other_bytes: 102 * 1024 * 1024,
      tables: [
        { name: "window_events", bytes: 120 * 1024 * 1024 },
        { name: "url_visits", bytes: 96 * 1024 * 1024 },
        { name: "key_sessions", bytes: 48 * 1024 * 1024 },
      ],
    }),
    capabilities: async () => ({ remote_script: true, scheduler_timezone: "Australia/Perth" }),
  };
}
