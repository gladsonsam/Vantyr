/** Shared helpers for retention day fields (server: null = unlimited global, or inherit on agent). */

type RetentionFieldMode = "global" | "agent";

export function daysToField(
  v: number | null | undefined,
  mode: RetentionFieldMode = "global",
): string {
  if (v == null) {
    return mode === "global" ? "0" : "";
  }
  if (v === 0) return "0";
  return String(v);
}

export function parseRetentionField(s: string, mode: RetentionFieldMode = "global"): {
  value: number | null;
  error: string | null;
} {
  try {
    return { value: fieldToDays(s, mode), error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Global: blank or 0 → unlimited (null API). Agent: blank → inherit (null), 0 → unlimited override (0 API).
 */
export function fieldToDays(s: string, mode: RetentionFieldMode = "global"): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) {
    throw new Error("Enter a whole number of days, or leave the field blank.");
  }
  const n = parseInt(t, 10);
  if (mode === "global") {
    if (n === 0) return null;
    if (n >= 1 && n <= 36500) return n;
    throw new Error("Use 0 for unlimited, or a number from 1 to 36500.");
  }
  if (n === 0) return 0;
  if (n >= 1 && n <= 36500) return n;
  throw new Error("Use 0 for unlimited, 1–36500 for a fixed window, or leave blank to inherit.");
}

/** Short label for read-only summaries. */
export function fmtRetentionBrief(d: number | null | undefined): string {
  if (d == null || d === 0) return "Unlimited";
  return `${d} days`;
}
