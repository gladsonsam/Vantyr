import { RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Input } from "@vantyr/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Label } from "@vantyr/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@vantyr/ui/components/popover";
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

/** Search above the activity timeline, with the date range and alerts-only tucked into a Filters popover. */
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

  const setRange = (start: string, end: string) =>
    onJumpRangeChange({ type: "absolute", startDate: start <= end ? start : end, endDate: start <= end ? end : start });
  // Search, alerts and app are their own controls; the popover's dot shows only date and alerts.
  const popoverActive = jumpRangeValue != null || alertsOnly;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <InputGroup className="h-9 min-w-0 flex-1 sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            id="activity-search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search activity"
            aria-label="Search loaded activity"
            type="search"
          />
        </InputGroup>
        <Popover>
          <PopoverTrigger render={<Button variant="outline" className="relative h-9" aria-label="Filters" />}>
            <SlidersHorizontal />
            <span className="hidden sm:inline">Filters</span>
            {popoverActive && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" aria-hidden="true" />}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-4 p-4">
            <div className="flex flex-col gap-2">
              <Label>Dates</Label>
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
                <SelectTrigger className="w-full" aria-label="Filter activity by calendar date range">
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
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="date"
                  aria-label="Start date"
                  value={bounds?.start ?? ""}
                  onChange={(event) => {
                    const start = event.target.value || bounds?.start || dayKey(new Date());
                    setRange(start, bounds?.end || start);
                  }}
                />
                <Input
                  type="date"
                  aria-label="End date"
                  value={bounds?.end ?? ""}
                  onChange={(event) => {
                    const end = event.target.value || bounds?.end || dayKey(new Date());
                    setRange(bounds?.start || end, end);
                  }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="activity-alerts-only"
                checked={alertsOnly}
                onCheckedChange={(checked) => setAlertsOnly(checked === true)}
              />
              <Label htmlFor="activity-alerts-only">Alerts only</Label>
            </div>
            {filters.isFiltered && (
              <Button variant="ghost" size="sm" className="self-start" onClick={filters.clearFilters}>
                Clear filters
              </Button>
            )}
          </PopoverContent>
        </Popover>
        {onRefresh && (
          <Button variant="ghost" size="icon" className="size-9" onClick={onRefresh} disabled={loading} aria-label="Refresh" title="Refresh">
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
        )}
      </div>
      {(appFilterExe || filters.isFiltered) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {appFilterExe ? (
            <Button variant="secondary" size="xs" onClick={() => setAppFilterExe(null)} title="Clear app filter">
              {appFilterExe} <X />
            </Button>
          ) : null}
          <span>{summary}</span>
          <Button variant="link" className="h-auto p-0 text-xs" onClick={filters.clearFilters}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
