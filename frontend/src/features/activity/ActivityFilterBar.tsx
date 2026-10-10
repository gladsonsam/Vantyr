import { X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
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
  summary,
  loading,
  onRefresh,
  onJumpRangeChange,
}: {
  filters: ActivityFilters;
  summary: string;
  loading: boolean;
  onRefresh?: () => void;
  onJumpRangeChange: (value: ActivityDateValue) => void;
}) {
  const { searchQuery, setSearchQuery, alertsOnly, setAlertsOnly, appFilterExe, setAppFilterExe, jumpRangeValue } =
    filters;
  const bounds = resolveDateRangeToDayBounds(jumpRangeValue);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-72 max-w-full">
        <Input
          id="activity-search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search apps, URLs, windows, keys…"
          aria-label="Search loaded activity"
          type="search"
        />
      </div>
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
      <div className="flex items-center gap-2 px-1">
        <Checkbox
          id="activity-alerts-only"
          checked={alertsOnly}
          onCheckedChange={(checked) => setAlertsOnly(checked === true)}
        />
        <Label htmlFor="activity-alerts-only">Alerts only</Label>
      </div>
      {appFilterExe ? (
        <Button variant="secondary" size="sm" onClick={() => setAppFilterExe(null)} title="Clear app filter">
          {appFilterExe} <X />
        </Button>
      ) : null}
      {filters.isFiltered ? (
        <Button variant="link" className="h-auto p-0 text-xs" onClick={filters.clearFilters}>
          Clear filters
        </Button>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{summary}</span>
        {onRefresh && (
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            {loading && <Spinner />} Refresh
          </Button>
        )}
      </div>
    </div>
  );
}
