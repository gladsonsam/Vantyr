import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { cn } from "@/lib/utils";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { Session } from "./sessionAggregator";
import {
  dayKey,
  filterTimelineSessions,
  findHighlightIndex,
  groupSessionsByDay,
  prepareTimelineSessions,
} from "./sessionTimeline";
import { resolveDateRangeToDayBounds, type ActivityDateValue } from "./activityDateRange";
import { ActivityFilterBar } from "./ActivityFilterBar";
import { SessionRow } from "./SessionRow";
import { DayOverview } from "./DayOverview";
import { computeDayStats } from "./dayStats";
import { formatDuration } from "./sessionAggregator";
import { useActivityFilters } from "./useActivityFilters";
import { useDayExpansion } from "./useDayExpansion";

interface ActivityTimelineProps {
  /** When set, Activity filters can be synced to `?activity=` in the URL. */
  agentId?: string;
  sessions: Session[];
  loading?: boolean;
  onRefresh?: () => void;
  onLoadMore?: () => void;
  hasMoreOlder?: boolean;
  loadingMore?: boolean;
  /** ISO string timestamp — scroll to and highlight the nearest session */
  highlightTimestamp?: string | null;
}

export function ActivityTimeline({
  agentId,
  sessions,
  loading,
  onRefresh,
  onLoadMore,
  hasMoreOlder = false,
  loadingMore = false,
  highlightTimestamp,
}: ActivityTimelineProps) {
  const filters = useActivityFilters(agentId);
  const { searchQuery, alertsOnly, appFilterExe, jumpRangeValue, isFiltered } = filters;
  const [screenshotModalId, setScreenshotModalId] = useState<number | null>(null);
  /** Session picked from a day strip; its row opens and scrolls into view. */
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const loadMoreVantyrRef = useRef<HTMLDivElement | null>(null);
  const lastAutoLoadMoreAtMsRef = useRef<number>(0);

  const sorted = useMemo(() => prepareTimelineSessions(sessions), [sessions]);
  const jumpRangeBounds = useMemo(() => resolveDateRangeToDayBounds(jumpRangeValue), [jumpRangeValue]);
  /** Deferred so typing in search does not re-filter a huge list on every keystroke. */
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredSorted = useMemo(
    () =>
      filterTimelineSessions(sorted, {
        alertsOnly,
        app: appFilterExe,
        query: deferredSearchQuery,
        days: jumpRangeBounds,
      }),
    [sorted, alertsOnly, appFilterExe, deferredSearchQuery, jumpRangeBounds],
  );
  const dayGroups = useMemo(() => groupSessionsByDay(filteredSorted), [filteredSorted]);
  const { isDayExpanded, toggleDay, expandDay, setAllDays, anyDayExpanded } = useDayExpansion(dayGroups);

  const scrollAfterDateApply = useRef(false);
  const { setJumpRangeValue } = filters;
  const onJumpRangeChange = useCallback((value: ActivityDateValue) => {
    setJumpRangeValue(value);
    if (value) scrollAfterDateApply.current = true;
  }, [setJumpRangeValue]);

  useEffect(() => {
    if (!scrollAfterDateApply.current) return;
    scrollAfterDateApply.current = false;
    const dk = dayGroups[0]?.dayKey;
    if (!dk) return;
    expandDay(dk);
    window.setTimeout(() => {
      document.getElementById(`vtl-day-${dk}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, [jumpRangeValue, dayGroups, expandDay]);

  // The session closest to the highlight timestamp (within the filtered list).
  const highlightIndex = useMemo(
    () => findHighlightIndex(filteredSorted, highlightTimestamp),
    [filteredSorted, highlightTimestamp],
  );

  // Open the day that contains the highlighted session (e.g. deep link from alerts)
  useEffect(() => {
    if (highlightIndex < 0 || !filteredSorted[highlightIndex]) return;
    expandDay(dayKey(filteredSorted[highlightIndex].startTime));
  }, [highlightIndex, highlightTimestamp, filteredSorted, expandDay]);

  
  const lastScrolledTimestamp = useRef<string | null>(null);
  useEffect(() => {
    if (highlightIndex < 0 || !highlightTimestamp) return;
    if (lastScrolledTimestamp.current === highlightTimestamp) return;
    lastScrolledTimestamp.current = highlightTimestamp;

    const id = filteredSorted[highlightIndex]?.id;
    const timer = setTimeout(() => {
      if (id) document.getElementById(`vtl-s-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
    return () => clearTimeout(timer);
  }, [highlightIndex, highlightTimestamp, filteredSorted]);

  const focusSession = useCallback((id: string) => {
    setFocusedId(id);
    window.setTimeout(() => {
      document.getElementById(`vtl-s-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }, []);

  const canAutoLoadMore =
    Boolean(onLoadMore) &&
    hasMoreOlder &&
    !loadingMore &&
    !loading &&
    !alertsOnly &&
    !jumpRangeValue &&
    !searchQuery.trim();

  // Infinite scroll: when the vantyr becomes visible, load older history in batches.
  useEffect(() => {
    const el = loadMoreVantyrRef.current;
    if (!el) return;
    if (!onLoadMore) return;

    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (!hit) return;
        if (!canAutoLoadMore) return;
        const now = Date.now();
        // Debounce auto loads to avoid rapid-fire calls while layout shifts.
        if (now - lastAutoLoadMoreAtMsRef.current < 900) return;
        lastAutoLoadMoreAtMsRef.current = now;
        onLoadMore();
      },
      { root: null, rootMargin: "900px 0px", threshold: 0.01 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [onLoadMore, canAutoLoadMore]);

  const headerDesc = useMemo(() => {
    const base = isFiltered
      ? `${filteredSorted.length} of ${sorted.length} sessions`
      : `${sorted.length} sessions`;
    return `${base}${highlightTimestamp ? " · at alert time" : ""}`;
  }, [filteredSorted.length, sorted.length, isFiltered, highlightTimestamp]);

  if (loading && sessions.length === 0) {
    return (
      <div className="flex justify-center px-5 py-16">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="px-5 py-16 text-center">
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      </div>
    );
  }

  return (
    <>
      <section className="flex flex-col gap-5">
        <ActivityFilterBar
          filters={filters}
          summary={headerDesc}
          loading={Boolean(loading)}
          onRefresh={onRefresh}
          onJumpRangeChange={onJumpRangeChange}
          anyDayExpanded={anyDayExpanded}
          onExpandAllDays={() => setAllDays(true)}
          onCollapseAllDays={() => setAllDays(false)}
        />

        {filteredSorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No matching sessions.</p>
        ) : (
          <>
            <div className="flex flex-col gap-6">
              {dayGroups.map((group) => {
                const expanded = isDayExpanded(group.dayKey);
                const daySessions = group.items.map((it) => it.session);
                const stats = computeDayStats(daySessions);
                return (
                  <div key={group.dayKey} id={`vtl-day-${group.dayKey}`} className="flex flex-col">
                    <button
                      type="button"
                      className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-3 border-b border-border/60 bg-background px-1 py-3 text-left"
                      onClick={() => toggleDay(group.dayKey)}
                      aria-expanded={expanded}
                    >
                      <ChevronRight
                        size={16}
                        className={cn("shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
                        aria-hidden
                      />
                      <span className="min-w-0 truncate font-heading text-[15px] font-semibold">{group.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                        {formatDuration(stats.activeSecs)} active · {group.items.length} sessions
                      </span>
                    </button>
                    {expanded && (
                      <div className="flex flex-col pt-4">
                        <DayOverview
                          sessions={daySessions}
                          stats={stats}
                          focusedId={focusedId}
                          appFilterExe={appFilterExe}
                          onSelect={focusSession}
                          onFilterApp={filters.toggleAppFilter}
                        />
                        <div className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-lg border border-border/70">
                          {group.items.map(({ session, idx }) => {
                            const isHighlighted = idx === highlightIndex && highlightTimestamp != null;
                            return (
                              <SessionRow
                                key={session.id}
                                session={session}
                                highlighted={isHighlighted}
                                focused={focusedId === session.id}
                                onOpenScreenshot={setScreenshotModalId}
                                onFilterApp={filters.toggleAppFilter}
                                agentId={agentId}
                                onActivityDeepLink={filters.deepLinkToActivity}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Infinite scroll sentinel (always present so the observer can attach). */}
            <div ref={loadMoreVantyrRef} className="h-px" />
            {onLoadMore && !jumpRangeValue && !alertsOnly && !searchQuery.trim() ? (
              <div className="grid justify-items-center gap-2 py-6 text-center">
                {hasMoreOlder ? (
                  <Button variant="outline" onClick={onLoadMore} disabled={loadingMore || Boolean(loading)}>
                    {loadingMore && <Spinner />} Load older
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">End of activity.</p>
                )}
              </div>
            ) : null}
          </>
        )}
      </section>
      <ScreenshotDialog
        title="Alert screenshot"
        eventId={screenshotModalId}
        onClose={() => setScreenshotModalId(null)}
      />
    </>
  );
}
