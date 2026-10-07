import { useCallback, useMemo, useState } from "react";
import type { DayGroup } from "./sessionTimeline";

/**
 * Which day groups of the timeline are open. Days the user has not toggled fall back to the
 * default: only the newest day is expanded.
 */
export function useDayExpansion(dayGroups: DayGroup[]) {
  /** Explicit expand/collapse per day; omitted keys use the default. */
  const [dayExpanded, setDayExpanded] = useState<Record<string, boolean>>({});
  const firstDayKey = dayGroups[0]?.dayKey ?? "";

  const isDayExpanded = useCallback(
    (key: string) => {
      if (key in dayExpanded) return dayExpanded[key]!;
      return key === firstDayKey;
    },
    [dayExpanded, firstDayKey],
  );

  const toggleDay = useCallback((key: string) => {
    setDayExpanded((prev) => {
      const current = key in prev ? prev[key]! : key === firstDayKey;
      return { ...prev, [key]: !current };
    });
  }, [firstDayKey]);

  const expandDay = useCallback((key: string) => {
    setDayExpanded((prev) => ({ ...prev, [key]: true }));
  }, []);

  const setAllDays = useCallback((open: boolean) => {
    const next: Record<string, boolean> = {};
    for (const g of dayGroups) next[g.dayKey] = open;
    setDayExpanded(next);
  }, [dayGroups]);

  const anyDayExpanded = useMemo(
    () => dayGroups.some((g) => isDayExpanded(g.dayKey)),
    [dayGroups, isDayExpanded],
  );

  return { isDayExpanded, toggleDay, expandDay, setAllDays, anyDayExpanded };
}
