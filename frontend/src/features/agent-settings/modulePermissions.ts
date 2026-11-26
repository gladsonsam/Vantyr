import type { DeviceModuleGrant, DeviceModuleId, ModuleStopRequest } from "@/api/types";
import { MODULE_LABELS, moduleLabel } from "@vantyr/ui/lib/moduleLabels";

// Typed against the server's module catalogue, so a new module is a compile error until it has a label.
const labels: Record<DeviceModuleId, string> = MODULE_LABELS;
export const DEVICE_MODULE_NAMES = Object.keys(labels) as DeviceModuleId[];
export { moduleLabel };
export function stopRequestLabel(status: string): string {
  if (["disabled", "duplicate", "confirmed", "acknowledged"].includes(status))
    return "Permission revocation confirmed";
  if (status === "stale") return "Device authorization changed; refresh and request again";
  if (status === "conflict") return "Request conflict; refresh and request again";
  if (status === "error" || status === "failed") return "Stop request failed";
  if (status === "sent") return "Sent; waiting for device confirmation";
  return "Queued; waiting for device confirmation";
}

export function workerStopLabel(request: ModuleStopRequest): string {
  if (request.stopped === true) return "Device confirmed worker shutdown";
  if (request.stop_status === "local_barrier_timeout")
    return "Some local operations are still finishing";
  if (request.stop_status === "registered_local_workers_drained_global_unconfirmed")
    return "Registered local workers stopped; full device shutdown remains unconfirmed";
  return "Worker shutdown remains unconfirmed";
}

export type ModuleGroupId = "monitoring" | "remote" | "device" | "system";

/** Typed against the module catalogue: a new module is a compile error until it has a group. */
const MODULE_GROUP_OF: Record<DeviceModuleId, ModuleGroupId> = {
  keyboard_text: "monitoring",
  idle_activity: "monitoring",
  window_activity: "monitoring",
  browser_urls: "monitoring",
  recall: "monitoring",
  live_screen: "remote",
  live_audio: "remote",
  remote_input: "remote",
  clipboard: "remote",
  files: "device",
  terminal: "device",
  scripts: "device",
  logs: "device",
  software_inventory: "system",
  resource_metrics: "system",
  system_info: "system",
  system_control: "system",
  app_policy: "system",
  network_policy: "system",
};

export const MODULE_GROUPS: { id: ModuleGroupId; label: string }[] = [
  { id: "monitoring", label: "Monitoring" },
  { id: "remote", label: "Remote control" },
  { id: "device", label: "Device access" },
  { id: "system", label: "System and policy" },
];

export function moduleGroup(module: string): ModuleGroupId {
  return (MODULE_GROUP_OF as Record<string, ModuleGroupId | undefined>)[module] ?? "system";
}

/** What the device's own report says about a module. `stopping` is a stop request still waiting for the device. */
export type ModuleStateKind = "on" | "off" | "unavailable" | "stopping";

export function moduleStateKind(grant: DeviceModuleGrant, stopPending: boolean): ModuleStateKind {
  if (!grant.available) return "unavailable";
  if (!grant.enabled) return "off";
  return stopPending ? "stopping" : "on";
}

/**
 * Short row text. "On" is only ever shown for a module the device reported as on; an offline device or a report from an
 * earlier connection says so, so a stale report is never read as the current permission.
 */
export function moduleStateText(
  kind: ModuleStateKind,
  reportQuality: { online: boolean; authorizationCurrent: boolean },
): string {
  if (kind === "unavailable") return "Unavailable";
  if (kind === "off") return "Off";
  if (kind === "stopping") return "Stop requested";
  if (!reportQuality.online) return "On · last report";
  return reportQuality.authorizationCurrent ? "On" : "On · earlier report";
}
