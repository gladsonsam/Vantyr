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

export function parseRetentionField(
  s: string,
  mode: RetentionFieldMode = "global",
): {
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

function fmtDays(d: number): string {
  return d === 1 ? "1 day" : `${d} days`;
}

/** Placeholder for an inheriting (blank) agent field. */
export function retentionDefaultPlaceholder(globalDays: number | null | undefined): string {
  return globalDays ? `Default: ${fmtDays(globalDays)}` : "Default: forever";
}

/**
 * One line saying what the typed value means for this device, next to the inherited default.
 * Empty while the text is not a valid value (the field's own error explains that).
 */
export function describeRetentionField(
  text: string,
  globalDays: number | null | undefined,
): string {
  const parsed = parseRetentionField(text, "agent");
  if (parsed.error) return "";
  const inherited = globalDays ? fmtDays(globalDays) : "forever";
  if (parsed.value === null) return `Uses the default: keeps ${inherited}.`;
  if (parsed.value === 0) return `Keeps forever, instead of the default (${inherited}).`;
  return `Keeps ${fmtDays(parsed.value)}; the default is ${inherited}.`;
}
