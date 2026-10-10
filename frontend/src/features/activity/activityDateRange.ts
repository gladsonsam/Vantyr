import { dayKey } from "./sessionTimeline";

/** Absolute calendar-day range filter (ISO `YYYY-MM-DD` day bounds, inclusive). */
export type ActivityDateValue = {
  type: "absolute";
  startDate: string;
  endDate: string;
} | null;

function parseISODateToLocalDay(dateIso: string | undefined): Date {
  if (!dateIso) return new Date(NaN);
  const datePart = dateIso.split("T")[0] ?? dateIso;
  const parts = datePart.split("-").map((x) => parseInt(x, 10));
  if (parts.length < 3) return new Date(NaN);
  const [y, m, d] = parts;
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return new Date(NaN);
  return new Date(y, m - 1, d);
}

export function resolveDateRangeToDayBounds(
  value: ActivityDateValue,
): { start: string; end: string } | null {
  if (!value) return null;
  const s = parseISODateToLocalDay(value.startDate);
  const e = parseISODateToLocalDay(value.endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
  const start = dayKey(s);
  const end = dayKey(e);
  return start <= end ? { start, end } : { start: end, end: start };
}

type DatePresetKey = "all" | "today" | "last-7" | "last-30" | "custom";

export const DATE_PRESETS: { key: Exclude<DatePresetKey, "custom">; label: string; days: number | null }[] = [
  { key: "all", label: "All days", days: null },
  { key: "today", label: "Today", days: 1 },
  { key: "last-7", label: "Last 7 days", days: 7 },
  { key: "last-30", label: "Last 30 days", days: 30 },
];

export function absoluteRangeForPresetDays(days: number): { start: string; end: string } {
  const today = new Date();
  const endDay = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const startD = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  startD.setDate(startD.getDate() - days + 1);
  return { start: dayKey(startD), end: endDay };
}

/** Which preset the current value corresponds to (`custom` for hand-picked dates). */
export function presetKeyForValue(value: ActivityDateValue): DatePresetKey {
  if (!value) return "all";
  const bounds = resolveDateRangeToDayBounds(value);
  if (!bounds) return "custom";
  for (const preset of DATE_PRESETS) {
    if (preset.days == null) continue;
    const expected = absoluteRangeForPresetDays(preset.days);
    if (expected.start === bounds.start && expected.end === bounds.end) return preset.key;
  }
  return "custom";
}
