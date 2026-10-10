import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@vantyr/ui/components/button";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { Session } from "./sessionAggregator";
import {
  filterTimelineSessions,
  findHighlightIndex,
  groupSessionsByDay,
  prepareTimelineSessions,
} from "./sessionTimeline";
import { resolveDateRangeToDayBounds, type ActivityDateValue } from "./activityDateRange";
import { ActivityFilterBar } from "./ActivityFilterBar";
import { SessionRow } from "./SessionRow";
import { TimelineOverview } from "./DayOverview";
import { computeDayStats } from "./dayStats";
import { useActivityFilters } from "./useActivityFilters";

const PAGE_SIZE = 120;

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
  /** Session picked from the overview strip; its row opens and scrolls into view. */
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
  const stats = useMemo(() => computeDayStats(filteredSorted), [filteredSorted]);

  /** Rows are rendered in slices so a long history does not mount thousands at once. */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const { setJumpRangeValue } = filters;
  const onJumpRangeChange = useCallback((value: ActivityDateValue) => setJumpRangeValue(value), [setJumpRangeValue]);

  // The session closest to the highlight timestamp (within the filtered list).
  const highlightIndex = useMemo(
    () => findHighlightIndex(filteredSorted, highlightTimestamp),
    [filteredSorted, highlightTimestamp],
  );
  const renderLimit = Math.max(visibleCount, highlightIndex + 1);

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

  const focusSession = useCallback(
    (id: string) => {
      const idx = filteredSorted.findIndex((x) => x.id === id);
      if (idx >= 0) setVisibleCount((c) => Math.max(c, idx + 1));
      setFocusedId(id);
      window.setTimeout(() => {
        document.getElementById(`vtl-s-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    },
    [filteredSorted],
  );

  const hasHiddenRows = renderLimit < filteredSorted.length;
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

    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (!hit) return;
        if (hasHiddenRows) {
          setVisibleCount((c) => c + PAGE_SIZE);
          return;
        }
        if (!canAutoLoadMore) return;
        const now = Date.now();
        // Debounce auto loads to avoid rapid-fire calls while layout shifts.
        if (now - lastAutoLoadMoreAtMsRef.current < 900) return;
        lastAutoLoadMoreAtMsRef.current = now;
        onLoadMore?.();
      },
      { root: null, rootMargin: "900px 0px", threshold: 0.01 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [onLoadMore, canAutoLoadMore, hasHiddenRows]);

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

  let rendered = 0;
  return (
    <>
      <section className="flex flex-col gap-5">
        <ActivityFilterBar
          filters={filters}
          summary={headerDesc}
          loading={Boolean(loading)}
          onRefresh={onRefresh}
          onJumpRangeChange={onJumpRangeChange}
        />

        {filteredSorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No matching sessions.</p>
        ) : (
          <>
            <TimelineOverview
              sessions={filteredSorted}
              stats={stats}
              focusedId={focusedId}
              appFilterExe={appFilterExe}
              onSelect={focusSession}
              onFilterApp={filters.toggleAppFilter}
            />
            <div className="flex flex-col overflow-hidden rounded-lg border border-border/70">
              {dayGroups.map((group) => {
                const items = group.items.filter(() => rendered++ < renderLimit);
                if (items.length === 0) return null;
                return (
                  <div key={group.dayKey} id={`vtl-day-${group.dayKey}`}>
                    <div className="sticky top-0 z-10 border-y border-border/60 bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground first:border-t-0">
                      {group.label}
                    </div>
                    <div className="flex flex-col divide-y divide-border/40">
                      {items.map(({ session, idx }) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          highlighted={idx === highlightIndex && highlightTimestamp != null}
                          focused={focusedId === session.id}
                          onOpenScreenshot={setScreenshotModalId}
                          onFilterApp={filters.toggleAppFilter}
                          agentId={agentId}
                          onActivityDeepLink={filters.deepLinkToActivity}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Sentinel: reveals more rows, then loads older history (always present so the observer attaches). */}
            <div ref={loadMoreVantyrRef} className="h-px" />
            {hasHiddenRows ? (
              <div className="grid justify-items-center py-4">
                <Button variant="outline" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                  Show more
                </Button>
              </div>
            ) : onLoadMore && !jumpRangeValue && !alertsOnly && !searchQuery.trim() ? (
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
