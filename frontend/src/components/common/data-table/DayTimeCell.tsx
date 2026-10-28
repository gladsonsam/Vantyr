import { fmtClock, fmtDateTime } from "@/lib/utils";
import { isDayGrouped, type SortableTable } from "./dayGroups";

/** Time cell for a day-grouped column: the clock under a day heading, the full date otherwise. */
export function DayTimeCell({ table, columnId, ts }: {
  table: SortableTable;
  columnId: string;
  ts: string | number | undefined;
}) {
  return <>{isDayGrouped(table, columnId) ? fmtClock(ts) : fmtDateTime(ts)}</>;
}
