/**
 * Formatting and colour helpers shared by the Recall views.
 *
 * Extracted from `RecallPage` so the standalone page, the per-agent tab and the
 * day panel format times, dates and categories identically — a day list that
 * disagreed with the date above it was a real bug class here, since days are
 * bucketed in the *agent's* zone while the viewer sits in their own.
 */

/** Category → accent colour for chips, bars and ribbon segments. */
const CATEGORY_COLOR: Record<string, string> = {
  dev: "#20dd8f",
  terminal: "#5eead4",
  browsing: "#60a5fa",
  comms: "#c084fc",
  docs: "#fbbf24",
  design: "#f472b6",
  media: "#f87171",
  other: "#94a3b8",
};

export function catColor(cat: string): string {
  return CATEGORY_COLOR[cat] ?? CATEGORY_COLOR.other;
}

/** Human label for a coarse category id. */
export function catLabel(cat: string): string {
  const LABELS: Record<string, string> = {
    dev: "Development",
    terminal: "Terminal",
    browsing: "Browsing",
    comms: "Communication",
    docs: "Documents",
    design: "Design",
    media: "Media",
    other: "Other",
  };
  return LABELS[cat] ?? cat;
}

/**
 * Today's calendar date in `tz` (or the viewer's own zone if unspecified), as
 * `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is the *UTC* date, so for
 * anyone east of UTC it names tomorrow late in the evening, and for anyone west it
 * names yesterday in the morning. `en-CA` formats as `YYYY-MM-DD`.
 */
export function todayIso(tz?: string): string {
  return new Date().toLocaleDateString("en-CA", tz ? { timeZone: tz } : undefined);
}

/** Time-of-day in the agent's zone, so labels match the day they're filed under. */
export function timeIn(tz: string | null, iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Time-of-day with seconds, for the playhead readout. */
export function timeWithSecondsIn(tz: string | null, ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** `Sat 6 Sep` — compact date for scrubber ticks and filmstrip day breaks. */
export function shortDateIn(tz: string | null, ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** `4h 12m` / `12m` / `48s` — durations as read, not as `HH:MM:SS`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/**
 * Parse a `YYYY-MM-DD` day as *local* midnight.
 *
 * `new Date("2026-09-07")` is parsed as UTC midnight, which renders as the previous
 * day for anyone west of UTC — so the weekday shown next to a date could contradict
 * the date itself. Appending a time forces local interpretation.
 */
export function parseDayLocal(day: string): Date {
  return new Date(`${day}T00:00:00`);
}

/** Calendar date containing an instant in the recording device's zone. */
export function dayIn(tz: string | null, ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { ...(tz ? { timeZone: tz } : {}),
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export function addCalendarDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Midnight boundaries in the agent zone, including 23/25-hour DST days. */
export function dayRange(day: string, tz: string | null): { fromMs: number; toMs: number } {
  const midnight = (date: string) => {
    if (!tz) return new Date(`${date}T00:00:00`).getTime();
    const target = Date.parse(`${date}T00:00:00Z`);
    let guess = target;
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    for (let i = 0; i < 4; i++) {
      const parts = Object.fromEntries(formatter.formatToParts(guess).map(p => [p.type, p.value]));
      const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
      guess += target - local;
    }
    return guess;
  };
  return { fromMs: midnight(day), toMs: midnight(addCalendarDays(day, 1)) };
}
