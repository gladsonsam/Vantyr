import { useState } from "react";
import { Bell, CalendarDays, Check, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Input } from "@vantyr/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@vantyr/ui/components/popover";
import {
  DATE_PRESETS,
  absoluteRangeForPresetDays,
  dateRangeLabel,
  presetKeyForValue,
  resolveDateRangeToDayBounds,
  type ActivityDateValue,
} from "./activityDateRange";
import { dayKey } from "./sessionTimeline";
import type { ActivityFilters } from "./useActivityFilters";

/**
 * Search, date range and alerts-only on one row, with every active filter shown (and removable)
 * as a chip underneath so it is always clear why the list is shorter than the history.
 */
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
  const {
    searchQuery,
    setSearchQuery,
    alertsOnly,
    setAlertsOnly,
    appFilterExe,
    setAppFilterExe,
    jumpRangeValue,
  } = filters;
  const [datesOpen, setDatesOpen] = useState(false);
  const bounds = resolveDateRangeToDayBounds(jumpRangeValue);
  const activePreset = presetKeyForValue(jumpRangeValue);
  const rangeLabel = dateRangeLabel(jumpRangeValue);

  const setRange = (start: string, end: string) =>
    onJumpRangeChange({
      type: "absolute",
      startDate: start <= end ? start : end,
      endDate: start <= end ? end : start,
    });
  const pickPreset = (key: string) => {
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    if (preset.days == null) onJumpRangeChange(null);
    else {
      const range = absoluteRangeForPresetDays(preset.days);
      onJumpRangeChange({ type: "absolute", startDate: range.start, endDate: range.end });
    }
    setDatesOpen(false);
  };

  return (
    <div className="flex flex-col gap-2.5">
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
        <Popover open={datesOpen} onOpenChange={setDatesOpen}>
          <PopoverTrigger
            render={
              <Button
                variant={jumpRangeValue ? "secondary" : "outline"}
                className="h-9 shrink-0"
                aria-label={`Dates: ${rangeLabel}`}
              />
            }
          >
            <CalendarDays />
            <span className="hidden max-w-36 truncate sm:inline">{rangeLabel}</span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 gap-3 p-3">
            <div className="flex flex-col gap-0.5" role="group" aria-label="Date range">
              {DATE_PRESETS.map((preset) => (
                <Button
                  key={preset.key}
                  variant="ghost"
                  className="h-9 justify-between"
                  aria-pressed={activePreset === preset.key}
                  onClick={() => pickPreset(preset.key)}
                >
                  {preset.label}
                  {activePreset === preset.key && <Check />}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
              <span className="text-xs font-medium text-muted-foreground">Custom range</span>
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
          </PopoverContent>
        </Popover>
        <Button
          variant={alertsOnly ? "secondary" : "outline"}
          className="h-9 shrink-0"
          aria-pressed={alertsOnly}
          aria-label="Alerts only"
          title="Show only sessions with alerts"
          onClick={() => setAlertsOnly(!alertsOnly)}
        >
          <Bell className={alertsOnly ? "text-destructive" : undefined} />
          <span className="hidden sm:inline">Alerts</span>
        </Button>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
          >
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
        )}
      </div>
      {filters.isFiltered && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
          {jumpRangeValue && (
            <FilterChip
              label={rangeLabel}
              remove="Remove date filter"
              onRemove={() => onJumpRangeChange(null)}
            />
          )}
          {alertsOnly && (
            <FilterChip
              label="Alerts only"
              remove="Remove alerts filter"
              onRemove={() => setAlertsOnly(false)}
            />
          )}
          {appFilterExe && (
            <FilterChip
              label={appFilterExe}
              remove="Remove app filter"
              onRemove={() => setAppFilterExe(null)}
            />
          )}
          {searchQuery.trim() && (
            <FilterChip
              label={`“${searchQuery.trim()}”`}
              remove="Clear search"
              onRemove={() => setSearchQuery("")}
            />
          )}
          <span className="tabular-nums">{summary}</span>
          <Button variant="link" className="h-auto p-0 text-xs" onClick={filters.clearFilters}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  remove,
  onRemove,
}: {
  label: string;
  remove: string;
  onRemove: () => void;
}) {
  return (
    <Button
      variant="secondary"
      size="xs"
      className="max-w-56 max-sm:h-8"
      onClick={onRemove}
      aria-label={`${remove}: ${label}`}
      title={remove}
    >
      <span className="truncate">{label}</span>
      <X />
    </Button>
  );
}
