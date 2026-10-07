import type { MjpegStreamTuning } from "@/api";
import type { MonitorInfo } from "@/api/types";

export type StreamPreset = "saver" | "balanced" | "sharp" | "ultra";

export const STREAM_PRESET_STORAGE_KEY = "vantyr.dashboard.screenStreamPreset";

export const STREAM_PRESET_TUNING: Record<StreamPreset, MjpegStreamTuning> = {
  saver:    { jpegQ: 28, intervalMs: 500 },
  balanced: { jpegQ: 40, intervalMs: 200 },
  sharp:    { jpegQ: 62, intervalMs: 80  },
  ultra:    { jpegQ: 75, intervalMs: 33  },
};

export const STREAM_PRESET_OPTIONS: Array<{ label: string; description: string; value: StreamPreset }> = [
  { label: "Bandwidth saver", description: "~2 fps — minimal bandwidth, best for slow connections.", value: "saver" },
  { label: "Balanced",        description: "~5 fps — default viewing profile.",                       value: "balanced" },
  { label: "Sharp",           description: "~12 fps — higher quality, more bandwidth.",               value: "sharp" },
  { label: "Ultra", description: "~30 fps — lowest latency, high CPU + network usage.",     value: "ultra" },
];

/** The viewer's last stream quality (per browser), `balanced` when unset or unreadable. */
export function loadStreamPreset(): StreamPreset {
  try {
    const raw = localStorage.getItem(STREAM_PRESET_STORAGE_KEY);
    if (raw === "saver" || raw === "balanced" || raw === "sharp" || raw === "ultra") return raw;
  } catch {
    /* ignore */
  }
  return "balanced";
}

export function saveStreamPreset(preset: StreamPreset) {
  try {
    localStorage.setItem(STREAM_PRESET_STORAGE_KEY, preset);
  } catch {
    /* ignore */
  }
}

/** Human-readable label for a monitor option (name + resolution + primary marker). */
export function monitorLabel(m: MonitorInfo, i: number): string {
  const base = m.name?.trim() || `Display ${i + 1}`;
  const res = m.width && m.height ? ` (${m.width}×${m.height})` : "";
  const primary = m.primary ? " • Primary" : "";
  return `${base}${res}${primary}`;
}
