export interface DeviceModuleGrant { module: string; available: boolean; enabled: boolean; revision: number; authorization_required: boolean }
export interface DeviceModuleReport { schema_version: number; revision: number; modules: DeviceModuleGrant[] }
export interface ModuleStopRequest { command_id: string; module: string; expected_revision: number; status: string; error?: string | null; created_at?: string }
export interface DeviceModuleStatus { state: DeviceModuleReport | null; online: boolean; reported_at: string | null; pending: ModuleStopRequest[] }
const labels: Record<string, string> = {
  keyboard_text: "Keyboard text", idle_activity: "Idle activity", window_activity: "Active window",
  browser_urls: "Browser URLs", recall: "Recall recordings", live_screen: "Live screen", live_audio: "Live audio",
  remote_input: "Remote input", files: "File access", terminal: "Terminal", scripts: "Scripts",
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
