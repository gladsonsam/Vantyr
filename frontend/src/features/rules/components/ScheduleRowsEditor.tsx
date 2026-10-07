import { Plus, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { FormSelect } from "@/components/common/form/FormSelect";
import { emptyScheduleRow, type ScheduleFormRow } from "../lib/scheduleRows";
import { DAY_OPTIONS } from "../rulesUtils";

/** Weekday + HH:MM start/end windows, used by the app block and internet access rules. */
export function ScheduleRowsEditor({ rows, onChange }: {
  rows: ScheduleFormRow[];
  onChange: (rows: ScheduleFormRow[]) => void;
}) {
  const patchRow = (i: number, patch: Partial<ScheduleFormRow>) => {
    const next = [...rows];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
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
            className="h-9 w-24"
            inputMode="numeric"
            value={r.start}
            onChange={(event) => patchRow(i, { start: event.target.value })}
            placeholder="HH:MM"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            aria-label={`Window ${i + 1} end time`}
            className="h-9 w-24"
            inputMode="numeric"
            value={r.end}
            onChange={(event) => patchRow(i, { end: event.target.value })}
            placeholder="HH:MM"
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Remove window"
            disabled={rows.length <= 1}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rows, emptyScheduleRow()])}>
        <Plus /> Add window
      </Button>
    </div>
  );
}
