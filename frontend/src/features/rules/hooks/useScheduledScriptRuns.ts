import { useQuery } from "@tanstack/react-query";
import { ruleQueries } from "@/api/queries/rules";
import type { ScheduledScriptEvent } from "@/api/types";

/** The newest fire of a script and how it went on each device it was sent to, counted by status. */
export type LastRun = { time: string; counts: Record<string, number> };
export type LastRuns = Record<number, LastRun>;

const NO_RUNS: LastRuns = {};
const EVENTS_PAGE = { limit: 500 };

/** Latest fire per script from the global run feed, with the outcome of every device in that fire. */
export function toLastRuns(data: { rows: ScheduledScriptEvent[] }): LastRuns {
  const runs: LastRuns = {};
  for (const ev of data.rows) {
    const existing = runs[ev.script_id];
    if (!existing || ev.expected_fire_time > existing.time) {
      runs[ev.script_id] = { time: ev.expected_fire_time, counts: { [ev.status]: 1 } };
    } else if (ev.expected_fire_time === existing.time) {
      existing.counts[ev.status] = (existing.counts[ev.status] ?? 0) + 1;
    }
  }
  return runs;
}

/**
 * Last run per script id. The feed holds the newest 500 runs; when it can't be read `failed` says so, so a
 * script is never shown as never having run just because its results didn't load.
 */
export function useScheduledScriptRuns() {
  const query = useQuery({ ...ruleQueries.scheduledScriptEventsAll(EVENTS_PAGE), select: toLastRuns });
  return {
    lastRuns: query.data ?? NO_RUNS,
    failed: query.isError && !query.data,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}
