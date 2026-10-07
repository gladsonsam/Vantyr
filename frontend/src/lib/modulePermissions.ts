import type { DeviceModuleGrant, DeviceModuleReport, ModuleStopRequest, DeviceModuleStatus } from "@/api/types";

export type { DeviceModuleGrant, DeviceModuleReport, ModuleStopRequest, DeviceModuleStatus };
const labels: Record<string, string> = {
  keyboard_text: "Keyboard text", idle_activity: "Idle activity", window_activity: "Active window",
  browser_urls: "Browser URLs", recall: "Recall recordings", live_screen: "Live screen", live_audio: "Live audio",
  clipboard: "Clipboard text", remote_input: "Remote input", files: "File access", terminal: "Terminal", scripts: "Scripts",
  software_inventory: "Software inventory", resource_metrics: "Resource metrics", system_info: "System details",
  system_control: "System control", app_policy: "App rules", network_policy: "Network rules", logs: "Log access",
};
export const DEVICE_MODULE_NAMES = Object.keys(labels);
export function moduleLabel(module: string): string { return labels[module] ?? module.replace(/_/g, " "); }
export function stopRequestLabel(status: string): string {
  if (["disabled", "duplicate", "confirmed", "acknowledged"].includes(status)) return "Permission revocation confirmed";
  if (status === "stale") return "Device authorization changed; refresh and request again";
  if (status === "conflict") return "Request conflict; refresh and request again";
  if (status === "error" || status === "failed") return "Stop request failed";
  if (status === "sent") return "Sent; waiting for device confirmation";
  return "Queued; waiting for device confirmation";
}

export function workerStopLabel(request: ModuleStopRequest): string {
  if (request.stopped === true) return "Device confirmed worker shutdown";
  if (request.stop_status === "local_barrier_timeout") return "Some local operations are still finishing";
  if (request.stop_status === "registered_local_workers_drained_global_unconfirmed") return "Registered local workers stopped; full device shutdown remains unconfirmed";
  return "Worker shutdown remains unconfirmed";
}
