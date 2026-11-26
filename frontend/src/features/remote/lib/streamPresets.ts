import type { MjpegStreamTuning } from "@/api";
import type { MonitorInfo } from "@/api/types";

export type ManualStreamPreset = "saver" | "balanced" | "sharp" | "ultra";
/** `auto` adapts to measured delivery; the others are fixed viewer choices. */
export type StreamPreset = "auto" | ManualStreamPreset;

export const STREAM_PRESET_STORAGE_KEY = "vantyr.dashboard.screenStreamPreset";

// Keep qualities within the deployed server’s 20–85 range. Low quality also
// raises H.264 CRF, so desktop text needs more than the old JPEG-40 default.
export const STREAM_PRESET_TUNING: Record<ManualStreamPreset, MjpegStreamTuning> = {
  saver: { jpegQ: 28, intervalMs: 500 },
  balanced: { jpegQ: 75, intervalMs: 200 },
  sharp: { jpegQ: 80, intervalMs: 80 },
  ultra: { jpegQ: 85, intervalMs: 33 },
};

/** H.264 capture interval per manual preset (the encoder, not the JPEG poll, paces video). */
export const STREAM_PRESET_VIDEO_INTERVAL_MS: Record<ManualStreamPreset, number> = {
  saver: 100,
  balanced: 50,
  sharp: 33,
  ultra: 33,
};

export interface AutoTier {
  label: string;
  jpegQ: number;
  intervalMs: number;
  videoIntervalMs: number;
}

/**
 * Auto's quality ladder, lowest to highest. The floor stays legible for desktop text (the
 * saver preset's quality 28 is grainy); the top matches Ultra. Auto starts at
 * {@link AUTO_START_TIER} and only climbs after sustained healthy delivery.
 */
export const AUTO_TIERS: readonly AutoTier[] = [
  { label: "Efficient", jpegQ: 55, intervalMs: 250, videoIntervalMs: 100 },
  {
    label: "Balanced",
    ...STREAM_PRESET_TUNING.balanced,
    videoIntervalMs: STREAM_PRESET_VIDEO_INTERVAL_MS.balanced,
  },
  {
    label: "Sharp",
    ...STREAM_PRESET_TUNING.sharp,
    videoIntervalMs: STREAM_PRESET_VIDEO_INTERVAL_MS.sharp,
  },
  {
    label: "Ultra",
    ...STREAM_PRESET_TUNING.ultra,
    videoIntervalMs: STREAM_PRESET_VIDEO_INTERVAL_MS.ultra,
  },
];
export const AUTO_START_TIER = 2;

/** The capture tuning a preset (or, for Auto, its current ladder tier) asks the agent for. */
export function resolveStreamTuning(
  preset: StreamPreset,
  autoTier: number,
  video: boolean,
): MjpegStreamTuning {
  if (preset === "auto") {
    const tier = AUTO_TIERS[Math.min(Math.max(autoTier, 0), AUTO_TIERS.length - 1)];
    return { jpegQ: tier.jpegQ, intervalMs: video ? tier.videoIntervalMs : tier.intervalMs };
  }
  const tuning = STREAM_PRESET_TUNING[preset];
  return video ? { ...tuning, intervalMs: STREAM_PRESET_VIDEO_INTERVAL_MS[preset] } : tuning;
}

export const STREAM_PRESET_OPTIONS: Array<{
  label: string;
  description: string;
  value: StreamPreset;
}> = [
  {
    label: "Auto",
    description: "Starts sharp and adapts delivery to this browser. Detail stays fixed while control is held.",
    value: "auto",
  },
  {
    label: "Bandwidth saver",
    description: "Lower bandwidth for slow connections.",
    value: "saver",
  },
  { label: "Balanced", description: "Everyday desktop work.", value: "balanced" },
  { label: "Sharp", description: "Clearer text and finer detail.", value: "sharp" },
  { label: "Ultra", description: "Smoothest motion; higher CPU and network use.", value: "ultra" },
];

/** The viewer's last stream quality (per browser), `auto` when unset or unreadable. */
export function loadStreamPreset(): StreamPreset {
  try {
    const raw = localStorage.getItem(STREAM_PRESET_STORAGE_KEY);
    if (
      raw === "auto" ||
      raw === "saver" ||
      raw === "balanced" ||
      raw === "sharp" ||
      raw === "ultra"
    )
      return raw;
  } catch {
    /* ignore */
  }
  return "auto";
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
