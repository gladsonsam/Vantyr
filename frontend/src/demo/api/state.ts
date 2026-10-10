import type { DeviceModuleStatus, RecallContextFilters, ScreenFrameSearchResult } from "@/api/types";
import { DEVICE_MODULE_NAMES } from "@/features/agent-settings/modulePermissions";
import { demoAgents } from "@/demo/data";

/**
 * Mutable fake-server state shared across the per-domain override modules. One instance per
 * demo client, so removing an agent or changing a setting in one domain shows up in the others.
 */
export function createDemoState() {
  const removedAgents = new Set<string>();
  // Bounded synthetic snapshots keep pages stable while the demo clock advances.
  const recallSearchPages = new Map<string, {device:string;query:string;filters:RecallContextFilters;scope:string;sort:string;monitor:number|null;from:number;to:number;results:ScreenFrameSearchResult[]}>();
  // Shared synthetic always-on quick-toggle configuration (not actual enforcement).
  const internetConfiguration = new Map<string, boolean>([["sitting-room", true]]);
  const configuredInternet = (id: string) => ({ blocked: internetConfiguration.get(id) ?? false, source: internetConfiguration.get(id) ? "agent" as const : null });
  // Ephemeral simulated clipboard, never persisted or sent to a real device.
  const clipboard = new Map<string, string>();
  const moduleReports = new Map<string, DeviceModuleStatus>();
  const moduleStatus = (id: string) => {
    let status = moduleReports.get(id);
    if (!status) {
      status = { online: demoAgents.some(a => a.id === id && a.online), reported_at: new Date().toISOString(), authorization_current: true, pending: [], state: { type: "module_states", schema_version: 1, revision: 1, modules: DEVICE_MODULE_NAMES.map(module => ({ module, available: true, enabled: ["recall", "live_screen", "remote_input", "clipboard", "resource_metrics", "system_info"].includes(module), revision: 1, authorization_required: !["recall", "live_screen", "remote_input", "clipboard", "resource_metrics", "system_info"].includes(module) })) } };
      moduleReports.set(id, status);
    }
    return status;
  };
  return { removedAgents, recallSearchPages, internetConfiguration, configuredInternet, clipboard, moduleReports, moduleStatus };
}

export type DemoState = ReturnType<typeof createDemoState>;
