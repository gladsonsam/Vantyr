import { z } from "zod";
import type { RuleSchedule } from "@/api/types";
import { minuteToTime, timeToMinute } from "../rulesUtils";

/** One editable schedule window: a weekday and HH:MM start/end in the agent's local time. */
export const scheduleRowSchema = z.object({
  day_of_week: z.number(),
  start: z.string(),
  end: z.string(),
});
export type ScheduleFormRow = z.infer<typeof scheduleRowSchema>;

export type ScheduleWindow = { day_of_week: number; start_minute: number; end_minute: number };

export function emptyScheduleRow(): ScheduleFormRow {
  return { day_of_week: 1, start: "00:00", end: "23:59" };
}

/** A window that may run past midnight (`endDay` differs from `day`). */
export type Span = { day: number; start: number; endDay: number; end: number };

/**
 * Join the two stored halves of an overnight window (Mon 22:00–24:00 + Tue 00:00–06:00) back into the one
 * window it was entered as. Only pairs the editor itself would split are joined, so re-saving is lossless.
 */
export function joinOvernight(windows: ScheduleWindow[]): Span[] {
  const used = new Set<number>();
  const pairs = new Map<number, number>();
  // Pair before emitting: the next day's half may occur first in a sorted response.
  windows.forEach((w, i) => {
    if (used.has(i) || w.end_minute !== 1440) return;
    const nextDay = (w.day_of_week + 1) % 7;
    const j = windows.findIndex(
      (x, k) =>
        k !== i &&
        !used.has(k) &&
        x.day_of_week === nextDay &&
        x.start_minute === 0 &&
        x.end_minute > 0 &&
        x.end_minute < w.start_minute,
    );
    if (j >= 0) {
      used.add(i);
      used.add(j);
      pairs.set(i, j);
    }
  });
  const spans: Span[] = [];
  windows.forEach((w, i) => {
    const j = pairs.get(i);
    if (j !== undefined) {
      spans.push({
        day: w.day_of_week,
        start: w.start_minute,
        endDay: windows[j].day_of_week,
        end: windows[j].end_minute,
      });
    } else if (!used.has(i)) {
      spans.push({
        day: w.day_of_week,
        start: w.start_minute,
        endDay: w.day_of_week,
        end: w.end_minute,
      });
    }
  });
  return spans;
}

export const SCHEDULE_NEEDS_WINDOW =
  "Schedule is enabled but no valid windows were provided (use HH:MM).";

/**
 * Why these rows can't be saved as a schedule, or null when they can. A row the server would never receive
 * (an unreadable time, or the same start and end) is named instead of being silently dropped.
 */
export function scheduleRowsProblem(rows: ScheduleFormRow[]): string | null {
  if (expandScheduleRows(rows).length === 0) return SCHEDULE_NEEDS_WINDOW;
  const bad = rows.findIndex((r) => {
    const s = timeToMinute(r.start);
    const e = timeToMinute(r.end);
    return s == null || e == null || s === e;
  });
  return bad < 0 ? null : `Window ${bad + 1} needs two different times in HH:MM.`;
}

/** Editable rows for stored windows; a rule with none gets one default row to edit. */
export function scheduleToRows(schedules: RuleSchedule[] | undefined | null): ScheduleFormRow[] {
  const list = Array.isArray(schedules) ? schedules : [];
  if (list.length === 0) return [emptyScheduleRow()];
  // The two stored halves of an overnight window come back as the one row it was entered as.
  return joinOvernight(list).map((s) => ({
    day_of_week: s.day,
    start: minuteToTime(s.start),
    end: minuteToTime(s.end),
  }));
}

/**
 * Turn form rows into stored windows. Rows with an unparsable time or equal start/end are dropped;
 * an overnight row (start after end) is split into the rest of its day plus the start of the next.
 */
export function expandScheduleRows(rows: ScheduleFormRow[]): ScheduleWindow[] {
  const out: ScheduleWindow[] = [];
  for (const r of rows) {
    const s = timeToMinute(r.start);
    const e = timeToMinute(r.end);
    if (s == null || e == null) continue;
    if (s === e) continue;
    if (s < e) {
      out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: e });
    } else {
      out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: 1440 });
      out.push({ day_of_week: (r.day_of_week + 1) % 7, start_minute: 0, end_minute: e });
    }
  }
  return out;
}
