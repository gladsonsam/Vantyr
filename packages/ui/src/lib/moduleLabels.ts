/** Display names for device modules, shared by the dashboard and the agent settings UI. */
export const MODULE_LABELS = {
  keyboard_text: "Keyboard text", idle_activity: "Idle activity", window_activity: "Active window",
  browser_urls: "Browser URLs", recall: "Recall recordings", live_screen: "Live screen", live_audio: "Live audio",
  clipboard: "Clipboard text", remote_input: "Remote input", files: "File access", terminal: "Terminal", scripts: "Scripts",
  software_inventory: "Software inventory", resource_metrics: "Resource metrics", system_info: "System details",
  system_control: "System control", app_policy: "App rules", network_policy: "Network rules", logs: "Log access",
} as const;

/** The module's display name; an unknown id falls back to a capitalised form of itself. */
export function moduleLabel(module: string): string {
  const known = (MODULE_LABELS as Record<string, string>)[module];
  if (known) return known;
  const words = module.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
