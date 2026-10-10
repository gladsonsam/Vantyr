import { isLockScreenApp } from "./sessionTimeline";

export const IDLE_APP = "__idle__";

/** Stable per-app hue so the same app reads the same colour on the strip, legend and rows. */
export function appColor(exeName: string): string {
  const key = (exeName ?? "").trim().toLowerCase();
  if (key === IDLE_APP || isLockScreenApp(key)) return "var(--muted-foreground)";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return `oklch(0.74 0.13 ${hash % 360})`;
}
