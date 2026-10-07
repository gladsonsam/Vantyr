import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { Spinner } from "@/components/ui/spinner";
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
import "./timeline.css";

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
      <div className="vantyr-activity-tab">
        <div className="flex justify-center px-5 py-16">
          <Spinner className="size-6" />
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="vantyr-activity-tab">
        <div className="px-5 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No activity yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="vantyr-activity-tab">
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
          <div className="vtl-root" style={{ paddingTop: toolbarExpanded ? 0 : 16 }}>
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
                <div className="vtl-list">
                  {dayGroups.map((group) => {
                    const expanded = isDayExpanded(group.dayKey);
                    return (
                      <div key={group.dayKey} id={`vtl-day-${group.dayKey}`} className="vtl-day-block">
                        <button
                          type="button"
                          className="vtl-day-header"
                          onClick={() => toggleDay(group.dayKey)}
                          aria-expanded={expanded}
                        >
                          <ChevronRight
                            size={16}
                            className={`vtl-day-chevron ${expanded ? "vtl-day-chevron--open" : ""}`}
                            aria-hidden
                          />
                          <Calendar size={15} style={{ opacity: 0.85 }} aria-hidden />
                          <span className="vtl-day-header-label">{group.label}</span>
                          <span className="vtl-day-header-cta">
                            {group.items.length} session{group.items.length === 1 ? "" : "s"}
                          </span>
                        </button>
                        {expanded && (
                          <div className="vtl-day-body">
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
                <div ref={loadMoreVantyrRef} style={{ height: 1 }} />
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
      </div>
      <ScreenshotDialog
        title="Alert screenshot"
        eventId={screenshotModalId}
        onClose={() => setScreenshotModalId(null)}
      />
    </>
  );
}
