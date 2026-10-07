import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import {
  DATE_PRESETS,
  absoluteRangeForPresetDays,
  presetKeyForValue,
  resolveDateRangeToDayBounds,
  type ActivityDateValue,
} from "./activityDateRange";
import { dayKey } from "./sessionTimeline";
import type { ActivityFilters } from "./useActivityFilters";

/** Search, date range, alerts-only and app filters shown above the activity timeline. */
export function ActivityFilterBar({
  filters,
  onJumpRangeChange,
  anyDayExpanded,
  onExpandAllDays,
  onCollapseAllDays,
}: {
  filters: ActivityFilters;
  onJumpRangeChange: (value: ActivityDateValue) => void;
  anyDayExpanded: boolean;
  onExpandAllDays: () => void;
  onCollapseAllDays: () => void;
}) {
  const { searchQuery, setSearchQuery, alertsOnly, setAlertsOnly, appFilterExe, setAppFilterExe, jumpRangeValue } =
    filters;
  const bounds = resolveDateRangeToDayBounds(jumpRangeValue);

  return (
    <div className="my-4 flex flex-wrap items-end gap-3 rounded-sm border bg-muted/45 p-3.5">
      <div className="grid gap-1.5">
        <Label htmlFor="activity-search">Search</Label>
        <div className="w-80 max-w-full">
          <Input
            id="activity-search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="App, URL, window, keys…"
            type="search"
          />
        </div>
        <p className="text-xs text-muted-foreground">Loaded history only.</p>
      </div>
      <div className="grid gap-1.5">
        <Label>Date range</Label>
        <div className="flex w-[230px] max-w-full flex-wrap items-center gap-2">
          <Select
            value={presetKeyForValue(jumpRangeValue)}
            onValueChange={(key) => {
              const preset = DATE_PRESETS.find((p) => p.key === key);
              if (!preset) return;
              if (preset.days == null) onJumpRangeChange(null);
              else {
                const range = absoluteRangeForPresetDays(preset.days);
                onJumpRangeChange({ type: "absolute", startDate: range.start, endDate: range.end });
              }
            }}
          >
            <SelectTrigger className="w-36" aria-label="Filter activity by calendar date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((preset) => (
                <SelectItem key={preset.key} value={preset.key}>
                  {preset.label}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Custom…
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            aria-label="Start date"
            className="w-auto"
            value={bounds?.start ?? ""}
            onChange={(event) => {
              const picked = event.target.value;
              const start = picked || bounds?.start || dayKey(new Date());
              const end = bounds?.end || start;
              onJumpRangeChange({
                type: "absolute",
                startDate: start <= end ? start : end,
                endDate: start <= end ? end : start,
              });
            }}
          />
          <Input
            type="date"
            aria-label="End date"
            className="w-auto"
            value={bounds?.end ?? ""}
            onChange={(event) => {
              const picked = event.target.value;
              const end = picked || bounds?.end || dayKey(new Date());
              const start = bounds?.start || end;
              onJumpRangeChange({
                type: "absolute",
                startDate: start <= end ? start : end,
                endDate: start <= end ? end : start,
              });
            }}
          />
        </div>
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 pb-px">
        <Button
          variant="link"
          className="h-auto shrink-0 p-0"
          onClick={() => (anyDayExpanded ? onCollapseAllDays() : onExpandAllDays())}
        >
          {anyDayExpanded ? "Collapse all" : "Expand all"}
        </Button>
        <div className="relative flex shrink-0 items-center gap-2">
          <Checkbox
            id="activity-alerts-only"
            checked={alertsOnly}
            onCheckedChange={(checked) => setAlertsOnly(checked === true)}
          />
          <Label htmlFor="activity-alerts-only">Alerts only</Label>
        </div>
        {appFilterExe ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="max-w-full truncate text-xs font-medium text-info">App: {appFilterExe}</span>
            <Button variant="link" className="h-auto shrink-0 p-0 text-xs" onClick={() => setAppFilterExe(null)}>
              Clear
            </Button>
          </div>
        ) : null}
        {filters.isFiltered ? (
          <Button variant="link" className="h-auto shrink-0 p-0" onClick={filters.clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
