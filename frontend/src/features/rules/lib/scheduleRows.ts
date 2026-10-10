import { z } from "zod";
import type { RuleSchedule } from "@/api/types";
import { minuteToTime, timeToMinute } from "../rulesUtils";

/** One editable schedule window: a weekday and HH:MM start/end in the agent's local time. */
export const scheduleRowSchema = z.object({ day_of_week: z.number(), start: z.string(), end: z.string() });
export type ScheduleFormRow = z.infer<typeof scheduleRowSchema>;

export type ScheduleWindow = { day_of_week: number; start_minute: number; end_minute: number };

export function emptyScheduleRow(): ScheduleFormRow {
  return { day_of_week: 1, start: "00:00", end: "23:59" };
}

/** Editable rows for stored windows; a rule with none gets one default row to edit. */
export function scheduleToRows(schedules: RuleSchedule[] | undefined | null): ScheduleFormRow[] {
  const list = Array.isArray(schedules) ? schedules : [];
  if (list.length === 0) return [emptyScheduleRow()];
  return list.map((w) => ({ day_of_week: w.day_of_week, start: minuteToTime(w.start_minute), end: minuteToTime(w.end_minute) }));
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
