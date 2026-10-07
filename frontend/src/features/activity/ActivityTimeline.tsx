import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronRight } from "lucide-react";
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
import { SessionItem } from "./SessionItem";
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
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  // Open the filter bar once when filters arrive pre-set (deep link).
  const initialFilterCheck = useRef(false);
  useEffect(() => {
    if (isFiltered && !initialFilterCheck.current) {
      setToolbarExpanded(true);
      initialFilterCheck.current = true;
    }
  }, [isFiltered]);

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

  const itemDivRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const setRef = useCallback((idx: number) => (el: HTMLDivElement | null) => {
    if (el) itemDivRefs.current.set(idx, el);
    else itemDivRefs.current.delete(idx);
  }, []);

  const lastScrolledTimestamp = useRef<string | null>(null);
  useEffect(() => {
    if (highlightIndex < 0 || !highlightTimestamp) return;
    if (lastScrolledTimestamp.current === highlightTimestamp) return;
    lastScrolledTimestamp.current = highlightTimestamp;

    const timer = setTimeout(() => {
      const el = itemDivRefs.current.get(highlightIndex);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
    return () => clearTimeout(timer);
  }, [highlightIndex, highlightTimestamp]);

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
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm text-muted-foreground">{headerDesc}</p>
          <div className="flex items-center gap-2">
            <Button
              variant={toolbarExpanded ? "default" : "outline"}
              size="sm"
              onClick={() => setToolbarExpanded(!toolbarExpanded)}
            >
              Filter
            </Button>
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                {loading && <Spinner />} Refresh
              </Button>
            )}
          </div>
        </div>
        <div className={cn(!toolbarExpanded && "pt-4")}>
          {toolbarExpanded && (
            <ActivityFilterBar
              filters={filters}
              onJumpRangeChange={onJumpRangeChange}
              anyDayExpanded={anyDayExpanded}
              onExpandAllDays={() => setAllDays(true)}
              onCollapseAllDays={() => setAllDays(false)}
            />
          )}

          {filteredSorted.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No matching sessions.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-[18px]">
                {dayGroups.map((group) => {
                  const expanded = isDayExpanded(group.dayKey);
                  return (
                    <div key={group.dayKey} id={`vtl-day-${group.dayKey}`} className="flex flex-col">
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm border bg-card px-3.5 py-2.5 text-left text-foreground transition-[border-color,background-color] duration-120 hover:border-foreground/10 hover:bg-muted"
                        onClick={() => toggleDay(group.dayKey)}
                        aria-expanded={expanded}
                      >
                        <ChevronRight
                          size={16}
                          className={cn("shrink-0 text-muted-foreground/72 transition-transform duration-150", expanded && "rotate-90")}
                          aria-hidden
                        />
                        <Calendar size={15} className="opacity-85" aria-hidden />
                        <span className="min-w-0 truncate font-heading text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">{group.label}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11.5px] font-semibold text-muted-foreground/72">
                          {group.items.length} session{group.items.length === 1 ? "" : "s"}
                        </span>
                      </button>
                      {expanded && (
                        <div className="flex flex-col px-1 pt-3.5 pb-0.5">
                          {group.items.map(({ session, idx }) => {
                            const isHighlighted = idx === highlightIndex && highlightTimestamp != null;
                            return (
                              <div key={session.id} ref={isHighlighted ? setRef(idx) : undefined}>
                                <SessionItem
                                  session={session}
                                  isLast={idx === filteredSorted.length - 1}
                                  highlighted={isHighlighted}
                                  forceExpanded={isHighlighted}
                                  onOpenScreenshot={setScreenshotModalId}
                                  onFilterApp={filters.toggleAppFilter}
                                  agentId={agentId}
                                  onActivityDeepLink={filters.deepLinkToActivity}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Infinite scroll vantyr (always present so observer can attach). */}
              <div ref={loadMoreVantyrRef} className="h-px" />
              {onLoadMore && !jumpRangeValue && !alertsOnly && !searchQuery.trim() ? (
                <div className="grid justify-items-center gap-2 py-6 text-center">
                  {hasMoreOlder ? (
                    <Button
                      variant="outline"
                      onClick={onLoadMore}
                      disabled={loadingMore || Boolean(loading)}
                    >
                      {loadingMore && <Spinner />} Load older
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      End of activity.
                    </p>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
      <ScreenshotDialog
        title="Alert screenshot"
        eventId={screenshotModalId}
        onClose={() => setScreenshotModalId(null)}
      />
    </>
  );
}
