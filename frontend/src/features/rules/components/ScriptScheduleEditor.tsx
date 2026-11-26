import { useRowKeys } from "@/hooks/useRowKeys";
import { Plus, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { FormSelect } from "@/components/common/form/FormSelect";
import {
  defaultScheduleRow,
  scriptFireMinute,
  type ScriptScheduleRow,
} from "../lib/scheduledScriptForm";
import { DAY_OPTIONS } from "../rulesUtils";

const FREQUENCY_OPTIONS = [
  { label: "Every hour", value: "hourly" },
  { label: "Every day", value: "daily" },
  { label: "Every week", value: "weekly" },
];

/** When a script fires: one row per schedule, each hourly (a minute), daily or weekly (a time of day). */
export function ScriptScheduleEditor({
  rows,
  onChange,
  timezone,
}: {
  rows: ScriptScheduleRow[];
  onChange: (rows: ScriptScheduleRow[]) => void;
  /** The timezone the times follow, when known. */
  timezone: string | null;
}) {
  const rowKeys = useRowKeys(rows);
  const patch = (i: number, change: Partial<ScriptScheduleRow>) => {
    const next = [...rows];
    next[i] = { ...next[i], ...change };
    onChange(next);
  };
  const setFrequency = (i: number, frequency: ScriptScheduleRow["frequency"]) => {
    // Hourly takes a minute, the others a time of day: start from a sensible value rather than a stale one.
    const timeStr =
      frequency === "hourly" ? "0" : rows[i].frequency === "hourly" ? "00:00" : rows[i].timeStr;
    patch(i, {
      frequency,
      timeStr,
      day_of_week: frequency === "weekly" ? (rows[i].day_of_week ?? 1) : undefined,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Times follow {timezone ? `the server’s timezone (${timezone})` : "the server’s timezone"},
        not each device’s clock.
      </p>
      {rows.map((s, i) => (
        <div
          key={rowKeys[i]}
          className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3"
        >
          <div className="min-w-32 flex-1">
            <FormSelect
              ariaLabel={`Schedule ${i + 1} frequency`}
              value={s.frequency}
              options={FREQUENCY_OPTIONS}
              onChange={(value) => setFrequency(i, value as ScriptScheduleRow["frequency"])}
            />
          </div>
          {s.frequency === "weekly" && (
            <div className="min-w-32 flex-1">
              <FormSelect
                ariaLabel={`Schedule ${i + 1} day`}
                value={String(s.day_of_week ?? 1)}
                options={DAY_OPTIONS}
                onChange={(value) => patch(i, { day_of_week: Number(value) })}
              />
            </div>
          )}
          <span className="text-sm text-muted-foreground">
            {s.frequency === "hourly" ? "at minute" : "at"}
          </span>
          <Input
            aria-label={`Schedule ${i + 1} ${s.frequency === "hourly" ? "minute" : "time"}`}
            aria-invalid={scriptFireMinute(s) === null || undefined}
            className="h-9 w-24"
            inputMode="numeric"
            autoComplete="off"
            value={s.timeStr}
            onChange={(event) => patch(i, { timeStr: event.target.value })}
            placeholder={s.frequency === "hourly" ? "0–59" : "HH:MM"}
          />
          <Button
            type="button"
            variant="ghost"
            className="pointer-coarse:h-9"
            aria-label={`Remove schedule ${i + 1}`}
            disabled={rows.length <= 1}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <X /> Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        className="self-start pointer-coarse:h-9"
        onClick={() => onChange([...rows, defaultScheduleRow()])}
      >
        <Plus /> Add schedule
      </Button>
    </div>
  );
}
