import { useQuery } from "@tanstack/react-query";
import { ruleQueries } from "@/api/queries/rules";
import type { ScheduledScriptEvent } from "@/api/types";

export type LastRuns = Record<number, { status: string; time: string }>;

const NO_RUNS: LastRuns = {};
const EVENTS_PAGE = { limit: 500 };

/** Latest run per script, from the global run feed. */
export function toLastRuns(data: { rows: ScheduledScriptEvent[] }): LastRuns {
  const runs: LastRuns = {};
  for (const ev of data.rows) {
    const existing = runs[ev.script_id];
    if (!existing || ev.expected_fire_time > existing.time) {
      runs[ev.script_id] = { status: ev.status, time: ev.expected_fire_time };
    }
  }
  return runs;
}

/** Last run per script id. The feed is best-effort: when it fails the map is empty. */
export function useScheduledScriptRuns() {
  const query = useQuery({ ...ruleQueries.scheduledScriptEventsAll(EVENTS_PAGE), select: toLastRuns });
  return { lastRuns: query.isError ? NO_RUNS : query.data ?? NO_RUNS, isFetching: query.isFetching };
}
