import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Calendar, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { Session } from "./sessionAggregator";
import {
  dayKey,
  dedupeWindowsByTimestampAndTitle,
  groupSessionsByDay,
  mergeAdjacentByApp,
  sessionMatchesSearch,
} from "./sessionTimeline";
import {
  DATE_PRESETS,
  absoluteRangeForPresetDays,
  presetKeyForValue,
  resolveDateRangeToDayBounds,
  type ActivityDateValue,
} from "./activityDateRange";
import { SessionItem } from "./SessionItem";
import "./timeline.css";
import {
  applyActivityStateToSearchParams,
  encodeActivityState,
  readActivityStateFromSearchParams,
  type ActivityUrlStateV1,
} from "./activityUrl";

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

// ── Main component ────────────────────────────────────────────────────────────

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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSyncEnabled = Boolean(agentId);

  const [screenshotModalId, setScreenshotModalId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [appFilterExe, setAppFilterExe] = useState<string | null>(null);
  const [jumpRangeValue, setJumpRangeValue] = useState<ActivityDateValue>(null);
  /** Explicit expand/collapse per day; omitted keys use default (newest day expanded only). */
  const [dayExpanded, setDayExpanded] = useState<Record<string, boolean>>({});
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  const initialFilterCheck = useRef(false);
  useEffect(() => {
    const hasInitialFilters = searchQuery.trim().length > 0 || alertsOnly || jumpRangeValue != null || Boolean(appFilterExe);
    if (hasInitialFilters && !initialFilterCheck.current) {
      setToolbarExpanded(true);
      initialFilterCheck.current = true;
    }
  }, [searchQuery, alertsOnly, jumpRangeValue, appFilterExe]);

  const loadMoreVantyrRef = useRef<HTMLDivElement | null>(null);
  const lastAutoLoadMoreAtMsRef = useRef<number>(0);
  const lastUrlActivityRawRef = useRef<string | null>(null);
  const skipActivityUrlPushRef = useRef(false);

  const buildActivityStateFromUi = useCallback((): ActivityUrlStateV1 | null => {
    const q = searchQuery.trim();
    const app = appFilterExe?.trim() ? appFilterExe.trim() : null;
    const bounds = resolveDateRangeToDayBounds(jumpRangeValue);
    const from = bounds?.start ?? null;
    const to = bounds?.end ?? null;
    if (!q && !alertsOnly && !app && !from && !to) return null;
    return {
      v: 1,
      q: q || undefined,
      alerts: alertsOnly ? true : undefined,
      app,
      from,
      to,
    };
  }, [searchQuery, alertsOnly, appFilterExe, jumpRangeValue]);

  const applyActivityStateToUi = useCallback((s: ActivityUrlStateV1 | null) => {
    if (!s) {
      setSearchQuery("");
      setAlertsOnly(false);
      setAppFilterExe(null);
      setJumpRangeValue(null);
      return;
    }
    setSearchQuery(s.q ?? "");
    setAlertsOnly(Boolean(s.alerts));
    setAppFilterExe(s.app ?? null);
    if (s.from && s.to) {
      setJumpRangeValue({
        type: "absolute",
        startDate: s.from,
        endDate: s.to,
      });
    } else {
      setJumpRangeValue(null);
    }
  }, []);

  // Apply `?activity=` from the URL into UI state (deep links).
  useEffect(() => {
    if (!urlSyncEnabled) return;
    const raw = searchParams.get("activity");
    if (raw === lastUrlActivityRawRef.current) return;
    lastUrlActivityRawRef.current = raw;
    const decoded = readActivityStateFromSearchParams(searchParams);
    skipActivityUrlPushRef.current = true;
    applyActivityStateToUi(decoded);
  }, [urlSyncEnabled, searchParams, applyActivityStateToUi]);

  // Push UI state into the URL (shareable), without clobbering unrelated params.
  useEffect(() => {
    if (!urlSyncEnabled) return;
    if (skipActivityUrlPushRef.current) {
      skipActivityUrlPushRef.current = false;
      return;
    }
    const nextState = buildActivityStateFromUi();
    const encoded = nextState ? encodeActivityState(nextState) : null;
    const current = searchParams.get("activity");
    if (encoded === current) return;

    setSearchParams((prev) => applyActivityStateToSearchParams(prev, nextState), { replace: true });
    lastUrlActivityRawRef.current = encoded;
  }, [urlSyncEnabled, buildActivityStateFromUi, setSearchParams, searchParams]);

  const deepLinkToActivity = useCallback(
    (patch: ActivityUrlStateV1) => {
      if (!agentId) return;
      const qs = applyActivityStateToSearchParams(new URLSearchParams(), patch);
      navigate(`/agents/${agentId}?${qs.toString()}`);
    },
    [agentId, navigate],
  );

  const sorted = useMemo(
    () =>
      mergeAdjacentByApp([...sessions].reverse()).map((s) => ({
        ...s,
        windows: dedupeWindowsByTimestampAndTitle(s.windows),
      })),
    [sessions],
  );

  const jumpRangeBounds = useMemo(() => resolveDateRangeToDayBounds(jumpRangeValue), [jumpRangeValue]);

  /** Deferred so typing in search does not re-filter a huge list on every keystroke. */
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const filteredSorted = useMemo(() => {
    let xs = sorted;
    if (alertsOnly) xs = xs.filter((s) => (s.alertEvents?.length ?? 0) > 0);
    if (appFilterExe) {
      const key = appFilterExe.toLowerCase();
      xs = xs.filter((s) => (s.appName || "").toLowerCase() === key);
    }
    if (deferredSearchQuery.trim()) {
      xs = xs.filter((s) => sessionMatchesSearch(s, deferredSearchQuery));
    }
    if (jumpRangeBounds) {
      xs = xs.filter((s) => {
        const k = dayKey(s.startTime);
        return k >= jumpRangeBounds.start && k <= jumpRangeBounds.end;
      });
    }
    return xs;
  }, [sorted, alertsOnly, appFilterExe, deferredSearchQuery, jumpRangeBounds]);

  const dayGroups = useMemo(() => groupSessionsByDay(filteredSorted), [filteredSorted]);

  const scrollAfterDateApply = useRef(false);
  const onJumpRangeChange = useCallback((value: ActivityDateValue) => {
    setJumpRangeValue(value);
    if (value) scrollAfterDateApply.current = true;
  }, []);

  useEffect(() => {
    if (!scrollAfterDateApply.current) return;
    scrollAfterDateApply.current = false;
    const dk = dayGroups[0]?.dayKey;
    if (!dk) return;
    setDayExpanded((prev) => ({ ...prev, [dk]: true }));
    window.setTimeout(() => {
      document.getElementById(`vtl-day-${dk}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, [jumpRangeValue, dayGroups]);

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

  const expandAllDays = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const g of dayGroups) next[g.dayKey] = true;
    setDayExpanded(next);
  }, [dayGroups]);

  const collapseAllDays = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const g of dayGroups) next[g.dayKey] = false;
    setDayExpanded(next);
  }, [dayGroups]);

  const anyDayExpanded = useMemo(() => {
    if (dayGroups.length === 0) return false;
    return dayGroups.some((g) => {
      if (g.dayKey in dayExpanded) return dayExpanded[g.dayKey]!;
      // Default behavior: newest day expanded only.
      return g.dayKey === firstDayKey;
    });
  }, [dayGroups, dayExpanded, firstDayKey]);

  // Find the index of the session closest to the highlight timestamp (within filtered list)
  const highlightIndex = useMemo(() => {
    if (!highlightTimestamp || filteredSorted.length === 0) return -1;
    const targetMs = new Date(highlightTimestamp).getTime();
    if (isNaN(targetMs)) return -1;
    let best = 0;
    let bestDist = Infinity;
    filteredSorted.forEach((s, i) => {
      const start = s.startTime.getTime();
      const end = s.endTime.getTime();
      const dist = targetMs < start ? start - targetMs : targetMs > end ? targetMs - end : 0;
      const isIdle = s.appName === "__idle__";
      const bestIdle = filteredSorted[best].appName === "__idle__";
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      } else if (dist === bestDist) {
        if (bestIdle && !isIdle) best = i;
      }
    });
    return best;
  }, [filteredSorted, highlightTimestamp]);

  // Open the day that contains the highlighted session (e.g. deep link from alerts)
  useEffect(() => {
    if (highlightIndex < 0 || !filteredSorted[highlightIndex]) return;
    const dk = dayKey(filteredSorted[highlightIndex].startTime);
    setDayExpanded((prev) => ({ ...prev, [dk]: true }));
  }, [highlightIndex, highlightTimestamp, filteredSorted]);

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



  const isFiltered = searchQuery.trim().length > 0 || alertsOnly || jumpRangeValue != null || Boolean(appFilterExe);
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
              <div className="vtl-toolbar">
                <div className="grid gap-1.5">
                  <Label htmlFor="activity-search">Search</Label>
                  <div className="vtl-toolbar-search">
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
                  <div className="vtl-toolbar-jump flex flex-wrap items-center gap-2">
                    <Select
                      value={presetKeyForValue(jumpRangeValue)}
                      onValueChange={(key) => {
                        const preset = DATE_PRESETS.find((p) => p.key === key);
                        if (!preset) return;
                        if (preset.days == null) onJumpRangeChange(null);
                        else {
                          const bounds = absoluteRangeForPresetDays(preset.days);
                          onJumpRangeChange({ type: "absolute", startDate: bounds.start, endDate: bounds.end });
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
                      value={resolveDateRangeToDayBounds(jumpRangeValue)?.start ?? ""}
                      onChange={(event) => {
                        const picked = event.target.value;
                        const current = resolveDateRangeToDayBounds(jumpRangeValue);
                        const start = picked || current?.start || dayKey(new Date());
                        const end = current?.end || start;
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
                      value={resolveDateRangeToDayBounds(jumpRangeValue)?.end ?? ""}
                      onChange={(event) => {
                        const picked = event.target.value;
                        const current = resolveDateRangeToDayBounds(jumpRangeValue);
                        const end = picked || current?.end || dayKey(new Date());
                        const start = current?.start || end;
                        onJumpRangeChange({
                          type: "absolute",
                          startDate: start <= end ? start : end,
                          endDate: start <= end ? end : start,
                        });
                      }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16, minHeight: 32, paddingBottom: 1, flexWrap: "wrap", rowGap: 8 }}>
                  <Button
                    variant="link"
                    className="h-auto shrink-0 p-0"
                    onClick={() => (anyDayExpanded ? collapseAllDays() : expandAllDays())}
                  >
                    {anyDayExpanded ? "Collapse all" : "Expand all"}
                  </Button>
                  <div className="vtl-toolbar-alerts flex shrink-0 items-center gap-2" style={{ height: "auto", position: "relative" }}>
                    <Checkbox
                      id="activity-alerts-only"
                      checked={alertsOnly}
                      onCheckedChange={(checked) => setAlertsOnly(checked === true)}
                    />
                    <Label htmlFor="activity-alerts-only">Alerts only</Label>
                  </div>
                  {appFilterExe ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className="max-w-full truncate text-xs font-medium text-info">App: {appFilterExe}</span>
                      <Button variant="link" className="h-auto shrink-0 p-0 text-xs" onClick={() => setAppFilterExe(null)}>
                        Clear
                      </Button>
                    </div>
                  ) : null}
                  {isFiltered ? (
                    <Button
                      variant="link"
                      className="h-auto shrink-0 p-0"
                      onClick={() => {
                        setSearchQuery("");
                        setAlertsOnly(false);
                        setAppFilterExe(null);
                        setJumpRangeValue(null);
                        if (urlSyncEnabled) {
                          skipActivityUrlPushRef.current = true;
                          lastUrlActivityRawRef.current = null;
                          setSearchParams((prev) => applyActivityStateToSearchParams(prev, null), { replace: true });
                        }
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              </div>
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
                                    onFilterApp={(exe) =>
                                      setAppFilterExe((prev) =>
                                        prev?.toLowerCase() === exe.toLowerCase() ? null : exe
                                      )
                                    }
                                    agentId={agentId}
                                    onActivityDeepLink={deepLinkToActivity}
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
