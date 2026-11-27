import { useRowKeys } from "@/hooks/useRowKeys";
import { Plus, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { FormSelect } from "@/components/common/form/FormSelect";
import { emptyScheduleRow, type ScheduleFormRow } from "../lib/scheduleRows";
import { DAY_OPTIONS, timeToMinute } from "../rulesUtils";
import { SCHEDULE_TIME_NOTE } from "./RuleScheduleSection";

/** The day a window that runs past midnight ends on, or null when it stays within its day or can't be read. */
function overnightEnd(row: ScheduleFormRow): string | null {
  const start = timeToMinute(row.start);
  const end = timeToMinute(row.end);
  if (start == null || end == null || start <= end) return null;
  return DAY_OPTIONS[(row.day_of_week + 1) % 7].label;
}

/** Weekday + HH:MM start/end windows, used by the app block and internet access rules. */
export function ScheduleRowsEditor({
  rows,
  onChange,
}: {
  rows: ScheduleFormRow[];
  onChange: (rows: ScheduleFormRow[]) => void;
}) {
  const patchRow = (i: number, patch: Partial<ScheduleFormRow>) => {
    const next = [...rows];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  const rowKeys = useRowKeys(rows);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{SCHEDULE_TIME_NOTE}</p>
      {rows.map((r, i) => {
        const next = overnightEnd(r);
        return (
          <div key={rowKeys[i]} className="flex flex-col gap-1 border-b border-border/60 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-32 flex-1">
                <FormSelect
                  ariaLabel={`Window ${i + 1} day`}
                  value={String(r.day_of_week)}
                  options={DAY_OPTIONS}
                  onChange={(value) => patchRow(i, { day_of_week: Number(value) })}
                />
              </div>
              <Input
                aria-label={`Window ${i + 1} start time`}
                aria-invalid={timeToMinute(r.start) == null || undefined}
                className="h-9 w-24"
                inputMode="numeric"
                autoComplete="off"
                value={r.start}
                onChange={(event) => patchRow(i, { start: event.target.value })}
                placeholder="HH:MM"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                aria-label={`Window ${i + 1} end time`}
                aria-invalid={timeToMinute(r.end) == null || undefined}
                className="h-9 w-24"
                inputMode="numeric"
                autoComplete="off"
                value={r.end}
                onChange={(event) => patchRow(i, { end: event.target.value })}
                placeholder="HH:MM"
              />
              <Button
                type="button"
                variant="ghost"
                className="pointer-coarse:h-9"
                aria-label={`Remove window ${i + 1}`}
                disabled={rows.length <= 1}
                onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              >
                <X /> Remove
              </Button>
            </div>
            {next && (
              <p className="text-xs text-muted-foreground">
                Runs overnight, until {next} {r.end}.
              </p>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        className="self-start pointer-coarse:h-9"
        onClick={() => onChange([...rows, emptyScheduleRow()])}
      >
        <Plus /> Add window
      </Button>
    </div>
  );
}
