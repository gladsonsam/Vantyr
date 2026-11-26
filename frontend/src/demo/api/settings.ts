import type { ApiClient } from "@/api";
import type { RetentionPolicy } from "@/api/types";
import { publishServerVersion } from "@/api/serverVersionStore";
import { asRecord } from "./helpers";

/** Fake retention, local UI password, auto-update and server capabilities endpoints. */
export function demoSettingsApi(): Partial<ApiClient> {
  // Per-device overrides persist for the session, so saving then reloading shows what was saved.
  const retention = new Map<string, RetentionPolicy | null>();
  const autoUpdate = new Map<string, { enabled: boolean } | null>();
  // Global limits and the auto-update default persist for the session too, so a saved change shows after a reload.
  let globalRetention: RetentionPolicy = { keylog_days: 14, window_days: 30, url_days: 30 };
  let globalAutoUpdate = true;
  return {
    retentionGlobalGet: async () => ({ ...globalRetention }),
    retentionGlobalPut: async (body) => {
      globalRetention = { ...body };
      return { ...globalRetention };
    },
    retentionAgentGet: async (id) => ({
      global: globalRetention,
      override: retention.get(id) ?? null,
    }),
    retentionAgentPut: async (id, body) => {
      retention.set(id, body);
      return { global: globalRetention, override: body };
    },
    retentionAgentDelete: async (id) => {
      retention.delete(id);
      return { global: globalRetention, override: null };
    },
    localUiPasswordGlobalGet: async () => ({ password_set: true }),
    localUiPasswordGlobalPut: async (body) => ({ password_set: Boolean(asRecord(body).password) }),
    localUiPasswordAgentGet: async () => ({ global: { password_set: true }, override: null }),
    localUiPasswordAgentPut: async (_id, body) => ({
      global: { password_set: true },
      override: { password_set: Boolean(asRecord(body).password) },
    }),
    localUiPasswordAgentDelete: async () => ({ global: { password_set: true }, override: null }),
    agentAutoUpdateGlobalGet: async () => ({ enabled: globalAutoUpdate }),
    agentAutoUpdateGlobalPut: async (body) => {
      globalAutoUpdate = Boolean(asRecord(body).enabled);
      return { enabled: globalAutoUpdate };
    },
    agentAutoUpdateAgentGet: async (id) => ({
      global: { enabled: globalAutoUpdate },
      override: autoUpdate.get(id) ?? null,
    }),
    agentAutoUpdateAgentPut: async (id, body) => {
      const override = { enabled: Boolean(asRecord(body).enabled) };
      autoUpdate.set(id, override);
      return { global: { enabled: globalAutoUpdate }, override };
    },
    agentAutoUpdateAgentDelete: async (id) => {
      autoUpdate.delete(id);
      return { global: { enabled: globalAutoUpdate }, override: null };
    },
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
