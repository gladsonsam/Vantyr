import "./recall.css";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { RefreshCw } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { loadFramePages } from "@/features/recall/lib/recallPaging";
import { api, errorText } from "@/api";
import type {
  ActivityPoint,
  ActivitySegment,
  DaySummary,
  HistoryMonitor,
  ScreenFrame,
} from "@/api/types";
import { RecallPlayer } from "./RecallPlayer";
import { RecallNavigation } from "./RecallNavigation";
import { RecallDayCoverageNote, RecallDayStepper } from "./RecallDayPicker";
import { HelpTip } from "@/components/common/HelpTip";
import { frameIndexAt } from "@/features/recall/lib/recallPlayback";
import type { SavedSearch } from "@/features/recall/lib/recallRetrieval";
import { useRecallPreferenceKey } from "@/features/recall/hooks/useRecallPreferenceKey";
import { RecallSearch } from "./RecallSearch";
import { recallQueries } from "@/api/queries/recall";
import { describeEmptyRange, latestRecordedDay } from "@/features/recall/lib/recallDefaults";
import { todayIso, dayIn, dayRange, shortDateIn, timeWithSecondsIn } from "@/features/recall/lib/recallFormat";

export type RangePreset = "6h" | "24h" | "7d";

const RANGE_MS: Record<RangePreset, number> = {
  "6h": 6 * 3600 * 1000,
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
};

/** Frames pulled per range. The server clamps well above this. */
const FRAME_LIMIT = 3000;

/** Window loaded around a search hit that falls outside the current range. */
const JUMP_PAD_MS = 30 * 60 * 1000;

interface RecallViewProps {
  agentId: string | null;
  /** Rendered at the start of the controls row — the standalone page puts its agent picker here. */
  agentPicker?: ReactNode;
  /** Shown on the stage when the agent has no frames in range. */
  emptyMessage?: string;
  /** Whether the device is connected; sharpens the empty-range explanation. */
  agentOnline?: boolean;
  /**
   * Deep link target: an instant to open on, as RFC3339. Loads a window around it
   * rather than the default range, so `?tab=recall&at=…` from a timeline row, a
   * window-focus event or a URL visit lands on that exact screen.
   */
  initialAtIso?: string | null;
  initialDay?: string | null;
  initialMonitor?: number | null;
  initialSearch?: SavedSearch | null;
  initialSearchError?: string | null;
  onSearchStateChange?: (search:SavedSearch|null)=>void;
  /** Reported whenever the view's shareable state changes, for URL sync. */
  onStateChange?: (state: { day: string; atMs: number; monitor: number | null }) => void;
  /** Extra panels rendered under the player (the day narrative, on the full page). */
  children?: (ctx: RecallDayContext) => ReactNode;
}

/** What the day panel needs from the view: which day, and how to seek the player. */
export interface RecallDayContext {
  agentId: string;
  day: string;
  onDayChange: (day: string) => void;
  summary: DaySummary | null;
  segments: ActivitySegment[];
  timezone: string | null;
  loading: boolean;
  dayError?: boolean;
  coverageScope?: string | null;
  onSeek: (iso: string) => void;
}


type RecallRange = { fromMs: number; toMs: number };
type Setter<T> = Dispatch<SetStateAction<T>>;
type RecallLocation = { day: string; atMs: number; monitor: number | null };

/** Playback presentation composes independent window, frame and day models. */
export function RecallView(props: RecallViewProps) {
  const { agentId, agentPicker, emptyMessage, initialSearchError, children } = props;
  const { preset, rangeKind, range, playheadMs, monitor, selectedFrameId, searchState, changeSearchState, preferencesKey,
    dayTimezone, monitors, reloadRange, summaryDay, changeDay, loadingFrames, error, dayContext,
    changePreset, seekSearchResult, seekPlayer, changeMonitor, seekNavigation, selectNavigationMonitor, changeRange,
    visibleFrames, visibleActivity, loadingPlayback, playbackEmptyMessage, rangeStatus, rangeNeedsAttention, navigationTimezone, displayedFrame,
  } = useRecallModel(props);
  const { playerRef, revealPlayer } = useRevealPlayer();
  const dayContextWithReveal = useMemo(
    () => (dayContext ? { ...dayContext, onSeek: (iso: string) => { dayContext.onSeek(iso); revealPlayer(); } } : null),
    [dayContext, revealPlayer],
  );
  if (!agentId) {
    return (
      <div className="flex flex-col gap-4">
        {agentPicker}
        <p className="text-sm text-muted-foreground">
          {emptyMessage ?? "Select an agent to replay its screen history."}
        </p>
      </div>
    );
  }

  const tzLabel = navigationTimezone ?? dayTimezone ?? "your browser's timezone";
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Recall controls" className="flex flex-col gap-2">
        <div className="recall-controls flex flex-wrap items-center gap-2">
          {agentPicker}
          {dayContext && (
            <RecallDayStepper
              agentId={agentId}
              day={summaryDay}
              onChange={changeDay}
              timezone={dayContext.timezone}
              coverageScope={dayContext.coverageScope}
              onSeek={dayContextWithReveal?.onSeek}
            />
          )}
          <ToggleGroup
            size="sm"
            spacing={0}
            className="rounded-lg bg-muted/70 p-0.5"
            aria-label="Show the most recent"
            value={rangeKind === "preset" ? [preset] : []}
            onValueChange={(value) => {
              changePreset(value);
            }}
          >
            <ToggleGroupItem value="6h" aria-label="Last 6 hours" className="rounded-md! px-2.5 aria-pressed:bg-background">
              Last 6h
            </ToggleGroupItem>
            <ToggleGroupItem value="24h" aria-label="Last 24 hours" className="rounded-md! px-2.5 aria-pressed:bg-background">
              Last 24h
            </ToggleGroupItem>
            <ToggleGroupItem value="7d" aria-label="Last 7 days" className="rounded-md! px-2.5 aria-pressed:bg-background">
              Last 7d
            </ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-9"
            onClick={reloadRange}
            disabled={loadingFrames}
            aria-label="Reload"
            title="Reload this window"
          >
            <RefreshCw className={loadingFrames ? "animate-spin" : undefined} />
          </Button>
        </div>
        <p
          role="status"
          className={`flex flex-wrap items-center gap-x-1.5 text-xs [overflow-wrap:anywhere] ${rangeNeedsAttention ? "text-warning" : "text-muted-foreground"}`}
        >
          <span>
            {shortDateIn(dayTimezone, range.fromMs)} {timeWithSecondsIn(dayTimezone, range.fromMs)} – {shortDateIn(dayTimezone, range.toMs)} {timeWithSecondsIn(dayTimezone, range.toMs)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{rangeStatus}</span>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1">
            Times in {tzLabel}
            <HelpTip>Timestamps use the device's own timezone when it is known. Older captures may have expired under the retention settings.</HelpTip>
          </span>
        </p>
        {dayContext && (
          <RecallDayCoverageNote
            agentId={agentId}
            day={summaryDay}
            onChange={changeDay}
            timezone={dayContext.timezone}
            coverageScope={dayContext.coverageScope}
          />
        )}
      </section>

      <RecallSearch key={`search:${agentId}`} agentId={agentId} monitor={monitor} onSeek={(iso, display, id) => { seekSearchResult(iso, display, id); revealPlayer(); }} timezone={dayTimezone} range={range} preferencesKey={preferencesKey} initialSearch={searchState} initialSearchError={initialSearchError} onSearchStateChange={changeSearchState} />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load captures</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div ref={playerRef} className="scroll-mt-24">
      <RecallPlayer
        selectedFrameId={selectedFrameId}
        key={`player:${agentId}:${monitor}`}
        agentId={agentId}
        frames={visibleFrames}
        fromMs={range.fromMs}
        toMs={range.toMs}
        playheadMs={playheadMs}
        onSeek={seekPlayer}
        loading={loadingPlayback}
        activity={visibleActivity}
        timezone={dayTimezone}
        monitors={monitors}
        monitor={monitor}
        onMonitorChange={changeMonitor}
        emptyMessage={playbackEmptyMessage}
      />
      </div>

      <RecallNavigation key={agentId} agentId={agentId} timezone={navigationTimezone} atMs={playheadMs} monitor={monitor}
        displayedFrame={displayedFrame}
        preferencesKey={preferencesKey} search={searchState} onSeek={(iso) => { seekNavigation(iso); revealPlayer(); }} onMonitor={selectNavigationMonitor}
        onRange={changeRange} />
      {children && dayContextWithReveal ? children(dayContextWithReveal) : null}
    </div>
  );
}

/**
 * Search results, bookmarks and day sessions sit away from the player; landing on a moment
 * brings the player into view so the click visibly "does something".
 */
function useRevealPlayer() {
  const playerRef = useRef<HTMLDivElement | null>(null);
  const revealPlayer = useCallback(() => {
    const el = playerRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    // The player is taller than a short screen, so "nearest" would leave it half hidden:
    // align its top under the pinned bar unless it already starts in the upper part of the view.
    const { top } = el.getBoundingClientRect();
    if (top >= 80 && top <= window.innerHeight * 0.35) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
  }, []);
  return { playerRef, revealPlayer };
}

function useRecallModel(props: RecallViewProps) {
  const { agentId, agentOnline, initialAtIso, initialDay, initialSearch, onSearchStateChange, onStateChange, emptyMessage } = props;
  const preferencesKey = useRecallPreferenceKey(agentId);
  const identityReady = typeof api.me !== "function" || Boolean(preferencesKey);
  const { searchState, changeSearchState } = useRecallSearchState(agentId, initialSearch, onSearchStateChange);
  const window = useRecallWindow(props);
  const { range, preset, playheadMs, monitor, selectedFrameId, summaryDay, agentScopeKey, pendingPlayheadRef, daySourceAllDisplaysRef,
    setRange, setPreset, setPlayheadMs, setMonitor, setSelectedFrameId, setSummaryDay, reloadRange, rangeKind, setPresetRange } = window;
  const windowScope = `${preferencesKey}:${agentId}:${range.fromMs}:${range.toMs}`;
  const frameScope = `${windowScope}:${monitor}`;
  const dayScope = `${preferencesKey}:${agentId}:${summaryDay}`;
  const { monitors, monitorsScope } = useRecallMonitors({ agentId, identityReady, range, windowScope, agentScopeKey, setMonitor, daySourceAllDisplaysRef });
  const { frames, activity, frameComplete, loadingFrames, error, loadedScope } = useRecallFrames({ agentId, identityReady, range, monitor, monitorsScope, windowScope, frameScope, pendingPlayheadRef, setPlayheadMs });
  const frameTimes = useMemo(() => frames.map(frame => Date.parse(frame.captured_at)), [frames]);
  const { daySummary, segments, dayTimezone, loadedDayScope, dayError, loadingDay } = useRecallDay({ agentId, identityReady, summaryDay, dayScope, zoneKey: `${preferencesKey}:${agentScopeKey}` });
  const { coverageDays, coverageZone, defaultDay } = useRecallCoverage({ agentId, identityReady, preferencesKey, dayTimezone, initialDay, initialAtIso, agentScopeKey });
  const initialSelection = useRecallInitialSelection({ dayTimezone, coverageZone, agentScopeKey, initialDay, initialAtIso, defaultDay, range, summaryDay });
  // These are this component's useState setters from useRecallWindow, not prop callbacks.
  // Adjusting the owner during render prevents a stale window from committing.
  // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
  if (initialSelection) { setSummaryDay(initialSelection.day); if (initialSelection.range !== range) setRange(initialSelection.range); }
  /**
   * Seek to an instant that may fall outside the loaded window.
   *
   * Search spans all retained history and the day panel can be pointed at any date,
   * so a target easily lands days outside the loaded range — where seeking alone
   * would clamp to the nearest loaded edge and show the wrong screen. Widen the
   * window around the target and let the load effect land the playhead on it.
   */
  const seekTo = useCallback(
    (ms: number) => {
      if (!range || !Number.isFinite(ms)) return;
      setSummaryDay(dayIn(dayTimezone, ms));
      if (ms >= range.fromMs && ms <= range.toMs) {
        setPlayheadMs(ms);
        return;
      }
      pendingPlayheadRef.current = ms;
      setRange({ fromMs: ms - JUMP_PAD_MS, toMs: ms + JUMP_PAD_MS });
    },
    [range, dayTimezone, setSummaryDay, setPlayheadMs, pendingPlayheadRef, setRange],
  );

  const changeDay = useCallback((day: string) => {
    setSummaryDay(day);
    const next = dayRange(day, dayTimezone);
    pendingPlayheadRef.current = next.fromMs;
    setRange(next);
  }, [dayTimezone, setSummaryDay, pendingPlayheadRef, setRange]);

  const seekToIso = useCallback((iso: string) => seekTo(new Date(iso).getTime()), [seekTo]);

  // Day evidence describes all displays, so a source jump must not inherit a
  // display filter or a previously selected search frame.
  const seekDaySource = useCallback((iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return;
    setSelectedFrameId(null);
    daySourceAllDisplaysRef.current = true;
    if (monitor !== null) pendingPlayheadRef.current = ms;
    setMonitor(null);
    seekToIso(iso);
  }, [monitor, seekToIso, setSelectedFrameId, daySourceAllDisplaysRef, pendingPlayheadRef, setMonitor]);


  useRecallLocationSync(onStateChange, { day: summaryDay, atMs: playheadMs, monitor }, !loadingFrames && loadedScope === frameScope);
  const dayContext: RecallDayContext | null = useMemo(
    () =>
      agentId
        ? {
            agentId,
            day: summaryDay,
            onDayChange: changeDay,
            summary: loadedDayScope === dayScope ? daySummary : null,
            segments: loadedDayScope === dayScope ? segments : [],
            timezone: loadedDayScope === dayScope ? dayTimezone : null,
            loading: loadingDay || loadedDayScope !== dayScope,
            dayError: loadedDayScope === dayScope && dayError,
            coverageScope: identityReady ? (preferencesKey ?? agentId) : null,
            onSeek: seekDaySource,
          }
        : null,
    [agentId, summaryDay, daySummary, segments, dayTimezone, loadingDay, seekDaySource, changeDay, loadedDayScope, dayScope, dayError, identityReady, preferencesKey],
  );


  const changePreset = useCallback((value: string[]) => {
    const next = value[0] as RangePreset | undefined;
    if (!next) return;
    pendingPlayheadRef.current = null;
    const toMs = Date.now();
    setPreset(next);
    setPresetRange({ fromMs: toMs - RANGE_MS[next], toMs });
  }, [pendingPlayheadRef, setPreset, setPresetRange]);
  const seekSearchResult = useCallback((iso: string, display?: number | null, id?: number | null) => {
    daySourceAllDisplaysRef.current = false;
    setSelectedFrameId(id ?? null);
    if ((display ?? null) !== monitor) pendingPlayheadRef.current = Date.parse(iso);
    setMonitor(display ?? null);
    seekToIso(iso);
  }, [daySourceAllDisplaysRef, pendingPlayheadRef, setSelectedFrameId, setMonitor, monitor, seekToIso]);
  const seekPlayer = useCallback((ms: number) => { setPlayheadMs(ms); setSummaryDay(dayIn(dayTimezone, ms)); }, [setPlayheadMs, setSummaryDay, dayTimezone]);
  const changeMonitor = useCallback((next: number | null) => { daySourceAllDisplaysRef.current = false; pendingPlayheadRef.current = playheadMs; setMonitor(next); }, [daySourceAllDisplaysRef, pendingPlayheadRef, playheadMs, setMonitor]);
  const seekNavigation = useCallback((iso: string) => { daySourceAllDisplaysRef.current = false; seekToIso(iso); }, [daySourceAllDisplaysRef, seekToIso]);
  const selectNavigationMonitor = useCallback((next: number | null) => { daySourceAllDisplaysRef.current = false; setMonitor(next); }, [daySourceAllDisplaysRef, setMonitor]);
  const changeRange = useCallback((next: RecallRange) => { pendingPlayheadRef.current = next.fromMs; setRange(next); setSummaryDay(dayIn(dayTimezone, next.fromMs)); }, [pendingPlayheadRef, setRange, setSummaryDay, dayTimezone]);
  const display = recallDisplay({ frames, frameTimes, activity, frameComplete, loadingFrames, error, loadedScope, frameScope, monitorsScope, windowScope,
    loadedDayScope, dayScope, dayTimezone, identityReady, selectedFrameId, playheadMs, emptyMessage, agentOnline, coverageDays, summaryDay, coverageZone });
  return { preset, rangeKind, range, playheadMs, monitor, selectedFrameId, searchState, changeSearchState, preferencesKey, dayTimezone, monitors, reloadRange, summaryDay, changeDay,
    loadingFrames, error, dayContext, changePreset, seekSearchResult, seekPlayer, changeMonitor, seekNavigation, selectNavigationMonitor, changeRange, ...display };
}

function initialRange(atIso?: string | null, day?: string | null): RecallRange {
  const at = atIso ? Date.parse(atIso) : NaN;
  if (Number.isFinite(at)) return { fromMs: at - JUMP_PAD_MS, toMs: at + JUMP_PAD_MS };
  if (day) return dayRange(day, null);
  const toMs = Date.now();
  return { fromMs: toMs - RANGE_MS["24h"], toMs };
}
function initialPlayhead(atIso?: string | null): number | null {
  const at = Date.parse(atIso ?? "");
  return Number.isFinite(at) ? at : null;
}
function initialSummaryDay(day?: string | null, at?: string | null) {
  if (day) return day;
  return at ? dayIn(null, Date.parse(at)) : todayIso();
}
function useRecallWindow({ agentId, initialAtIso, initialDay, initialMonitor }: RecallViewProps) {
  const [preset, setPreset] = useState<RangePreset>("24h");
  const [range, setRangeRaw] = useState(() => initialRange(initialAtIso, initialDay));
  // A rolling "last N hours" window and a chosen day/moment are different things; the toolbar
  // only highlights a preset while one is really in effect.
  const [rangeKind, setRangeKind] = useState<"preset" | "chosen">(initialAtIso || initialDay ? "chosen" : "preset");
  const setRange = useCallback((next: RecallRange) => { setRangeKind("chosen"); setRangeRaw(next); }, []);
  const setPresetRange = useCallback((next: RecallRange) => { setRangeKind("preset"); setRangeRaw(next); }, []);
  const [playheadMs, setPlayheadMs] = useState(() => Date.now());
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [monitor, setMonitor] = useState<number | null>(initialMonitor ?? null);
  const [summaryDay, setSummaryDay] = useState(initialDay ?? todayIso());
  const daySourceAllDisplaysRef = useRef(false);
  const [initialTarget] = useState(() => initialPlayhead(initialAtIso));
  const pendingPlayheadRef = useRef<number | null>(initialTarget);
  const resetRange = useCallback(() => {
    pendingPlayheadRef.current = null;
    daySourceAllDisplaysRef.current = false;
    const toMs = Date.now();
    setPresetRange({ fromMs: toMs - RANGE_MS[preset], toMs });
  }, [preset, setPresetRange]);
  // Reload re-reads what is on screen: a rolling window moves to "now", a chosen day or moment
  // is fetched again in place and keeps its playhead.
  const reloadRange = useCallback(() => {
    if (rangeKind === "preset") { resetRange(); return; }
    pendingPlayheadRef.current = playheadMs;
    daySourceAllDisplaysRef.current = false;
    setRangeRaw((current) => ({ ...current }));
  }, [rangeKind, resetRange, playheadMs]);
  const previousScope = useRef({ agentId, preset });
  useEffect(() => {
    if (previousScope.current.agentId === agentId && previousScope.current.preset === preset) return;
    previousScope.current = { agentId, preset };
    resetRange();
  }, [agentId, preset, resetRange]);
  const agentScopeKey = `${agentId}:${initialMonitor ?? ""}:${initialDay ?? ""}:${initialAtIso ?? ""}`;
  const [previousAgentScope, setPreviousAgentScope] = useState(agentScopeKey);
  if (previousAgentScope !== agentScopeKey) {
    setPreviousAgentScope(agentScopeKey);
    setSummaryDay(initialSummaryDay(initialDay, initialAtIso));
    setMonitor(initialMonitor ?? null);
    setSelectedFrameId(null);
  }
  useEffect(() => { daySourceAllDisplaysRef.current = false; }, [agentId, initialMonitor, initialDay, initialAtIso]);
  return { preset, setPreset, range, setRange, playheadMs, setPlayheadMs, selectedFrameId, setSelectedFrameId, monitor, setMonitor,
    summaryDay, setSummaryDay, daySourceAllDisplaysRef, pendingPlayheadRef, resetRange, reloadRange, rangeKind, setPresetRange, agentScopeKey };
}
function useRecallSearchState(agentId: string | null, initialSearch: SavedSearch | null | undefined, onSearchStateChange: RecallViewProps["onSearchStateChange"]) {
  const [draft, setDraft] = useState({ agent: agentId, value: initialSearch ?? null });
  const searchState = draft.agent === agentId ? draft.value : initialSearch ?? null;
  const changeSearchState = useCallback((search: SavedSearch | null) => { setDraft({ agent: agentId, value: search }); onSearchStateChange?.(search); }, [agentId, onSearchStateChange]);
  return { searchState, changeSearchState };
}

function useRecallMonitors({ agentId, identityReady, range, windowScope, agentScopeKey, setMonitor, daySourceAllDisplaysRef }: {
  agentId: string | null; identityReady: boolean; range: RecallRange; windowScope: string; agentScopeKey: string;
  setMonitor: Setter<number | null>; daySourceAllDisplaysRef: RefObject<boolean>;
}) {
  const [monitors, setMonitors] = useState<HistoryMonitor[]>([]);
  const [monitorsScope, setMonitorsScope] = useState("");
  const [previousAgent, setPreviousAgent] = useState(agentScopeKey);
  if (previousAgent !== agentScopeKey) { setPreviousAgent(agentScopeKey); setMonitors([]); }
  // ── Which displays exist in this window ─────────────────────────────────────
  useEffect(() => {
    if (!agentId || !identityReady || !range) return;
    let alive = true;
    const from = new Date(range.fromMs).toISOString();
    const to = new Date(range.toMs).toISOString();
    api
      .historyMonitors(agentId, { from, to })
      .then((res) => {
        if (!alive) return;
        setMonitors(res.monitors);
        setMonitorsScope(windowScope);
        // Default to the busiest display rather than "all". Interleaving every
        // monitor's frames into one timelapse cuts between two different screens on
        // alternating frames, which reads as a broken player.
        setMonitor((cur) => {
          if (daySourceAllDisplaysRef.current) return null;
          if (cur != null && res.monitors.some((m) => m.monitor === cur)) return cur;
          const busiest = res.monitors.reduce<HistoryMonitor | null>(
            (best, m) => (best === null || m.frame_count > best.frame_count ? m : best),
            null,
          );
          return busiest?.monitor ?? null;
        });
      })
      .catch(() => { if (alive) { setMonitors([]); setMonitorsScope(windowScope); } });
    return () => {
      alive = false;
    };
  }, [agentId, identityReady, range, windowScope, setMonitor, daySourceAllDisplaysRef]);

  return { monitors, monitorsScope };
}

function useRecallFrames({ agentId, identityReady, range, monitor, monitorsScope, windowScope, frameScope, pendingPlayheadRef, setPlayheadMs }: {
  agentId: string | null; identityReady: boolean; range: RecallRange; monitor: number | null; monitorsScope: string; windowScope: string; frameScope: string;
  pendingPlayheadRef: RefObject<number | null>; setPlayheadMs: Setter<number>;
}) {
  const [frames, setFrames] = useState<ScreenFrame[]>([]);
  const [activity, setActivity] = useState<{ points: ActivityPoint[]; bucketSecs: number } | null>(null);
  const [frameComplete, setFrameComplete] = useState<boolean | null>(null);
  const [loadingFrames, setLoadingFrames] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState("");
  // ── Frames + activity for the window ────────────────────────────────────────
  // `monitor` is deliberately a dependency: changing displays reloads, because the
  // two screens have entirely different keyframe sets. The previous round's
  // frames clear with their scope during render; the effect below only fetches.
  const frameFetchKey = `${frameScope}:${monitorsScope}`;
  const [prevFrameFetchKey, setPrevFrameFetchKey] = useState(frameFetchKey);
  if (prevFrameFetchKey !== frameFetchKey) {
    setPrevFrameFetchKey(frameFetchKey);
    setFrames([]);
    setActivity(null);
    setLoadingFrames(true);
    setError(null);
    setFrameComplete(null);
  }
  useEffect(() => {
    if (!agentId || !identityReady || !range || monitorsScope !== windowScope) return;
    let alive = true;
    const from = new Date(range.fromMs).toISOString();
    const to = new Date(range.toMs).toISOString();
    let loadedFrames: ScreenFrame[] = [];
    loadFramePages(
      (cursor) => api.historyFrames(agentId, { from, to, monitor, limit: FRAME_LIMIT, cursor }),
      (progress) => {
        if (!alive) return;
        loadedFrames = progress.frames;
        setFrames(progress.frames);
        setFrameComplete(progress.complete);
        setLoadedScope(frameScope);
      },
      () => alive,
    )
      .then(() => {
        if (!alive) return;
        // Consume a seeded seek only after all pages arrive, including its target.
        const want = pendingPlayheadRef.current;
        pendingPlayheadRef.current = null;
        const last = loadedFrames[loadedFrames.length - 1];
        setPlayheadMs(want ?? (last ? Date.parse(last.captured_at) : range.toMs));
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => { if (alive) setLoadingFrames(false); });

    api
      .historyActivity(agentId, { from, to, monitor, buckets: 200 })
      .then((res) => alive && setActivity({ points: res.points, bucketSecs: res.bucket_secs }))
      .catch(() => alive && setActivity(null));
    return () => {
      alive = false;
    };
  }, [agentId, identityReady, range, monitor, monitorsScope, windowScope, frameScope, pendingPlayheadRef, setPlayheadMs]);

  return { frames, activity, frameComplete, loadingFrames, error, loadedScope };
}

function useRecallDay({ agentId, identityReady, summaryDay, dayScope, zoneKey }: { agentId: string | null; identityReady: boolean; summaryDay: string; dayScope: string; zoneKey: string }) {
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [segments, setSegments] = useState<ActivitySegment[]>([]);
  const [dayTimezone, setDayTimezone] = useState<string | null>(null);
  const [loadedDayScope, setLoadedDayScope] = useState("");
  const [dayError, setDayError] = useState(false);
  const [loadingDay, setLoadingDay] = useState(false);
  const [previousZoneKey, setPreviousZoneKey] = useState(zoneKey);
  if (previousZoneKey !== zoneKey) { setPreviousZoneKey(zoneKey); setDayTimezone(null); }
  // ── Day narrative + segments ────────────────────────────────────────────────
  // The previous day's narrative clears with its scope during render; the
  // effect below only fetches.
  const dayFetchKey = `${dayScope}:${identityReady}`;
  const [prevDayFetchKey, setPrevDayFetchKey] = useState(dayFetchKey);
  if (prevDayFetchKey !== dayFetchKey) {
    setPrevDayFetchKey(dayFetchKey);
    setDaySummary(null);
    setSegments([]);
    setLoadingDay(true);
    setDayError(false);
  }
  useEffect(() => {
    if (!agentId || !identityReady) return;
    let alive = true;
    Promise.all([
      api.historyDaySummary(agentId, summaryDay),
      api.historySegments(agentId, summaryDay),
    ])
      .then(([sum, segs]) => {
        if (!alive) return;
        setLoadedDayScope(dayScope);
        setDaySummary(sum.summary);
        setSegments(segs.segments);
        setDayTimezone(sum.timezone ?? segs.timezone ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setLoadedDayScope(dayScope);
        setDaySummary(null);
        setSegments([]);
        setDayError(true);
      })
      .finally(() => { if (alive) setLoadingDay(false); });
    return () => {
      alive = false;
    };
  }, [agentId, identityReady, summaryDay, dayScope]);

  return { daySummary, segments, dayTimezone, loadedDayScope, dayError, loadingDay };
}

function useRecallCoverage({ agentId, identityReady, preferencesKey, dayTimezone, initialDay, initialAtIso, agentScopeKey }: {
  agentId: string | null; identityReady: boolean; preferencesKey: string | null; dayTimezone: string | null;
  initialDay?: string | null; initialAtIso?: string | null; agentScopeKey: string;
}) {
  const coverageQuery = useQuery({ ...recallQueries.days(agentId ?? "", preferencesKey ?? agentId), enabled: !!agentId && identityReady });
  const coverageDays = coverageQuery.isError ? null : coverageQuery.data?.days ?? null;
  const coverageZone = coverageQuery.data?.timezone ?? dayTimezone;
  const [defaultDayChecked, setDefaultDayChecked] = useState<string | null>(null);
  const [defaultDay, setDefaultDay] = useState<{ scope: string; day: string } | null>(null);
  if (coverageDays && !initialDay && !initialAtIso && defaultDayChecked !== agentScopeKey) {
    setDefaultDayChecked(agentScopeKey);
    const today = todayIso(coverageZone ?? undefined);
    const latest = latestRecordedDay(coverageDays, today);
    if (latest && latest.day !== today) {
      setDefaultDay({ scope: agentScopeKey, day: latest.day });

    }
  }
  return { coverageDays, coverageZone, defaultDay };
}
interface InitialSelectionOptions {
  dayTimezone: string | null; coverageZone: string | null; agentScopeKey: string;
  initialDay?: string | null; initialAtIso?: string | null; defaultDay: { scope: string; day: string } | null;
  range: RecallRange; summaryDay: string;
}
function selectionInZone({ initialDay, initialAtIso, dayTimezone, defaultDay, agentScopeKey, range, summaryDay }: InitialSelectionOptions) {
  if (initialDay) return { day: summaryDay, range: initialAtIso ? range : dayRange(initialDay, dayTimezone) };
  if (initialAtIso) return { day: dayIn(dayTimezone, Date.parse(initialAtIso)), range };
  const day = defaultDay?.scope === agentScopeKey ? defaultDay.day : todayIso(dayTimezone ?? undefined);
  return { day, range };
}
/** Return initialization adjustments to the window owner; no callback runs during render. */
function useRecallInitialSelection(options: InitialSelectionOptions) {
  const { dayTimezone, coverageZone, agentScopeKey, defaultDay } = options;
  const [zoneApplyScope, setZoneApplyScope] = useState<string | null>(null);
  const [defaultApplyScope, setDefaultApplyScope] = useState<string | null>(null);
  if (dayTimezone && zoneApplyScope !== agentScopeKey) {
    setZoneApplyScope(agentScopeKey);
    return selectionInZone(options);
  }
  if (defaultDay?.scope === agentScopeKey && defaultApplyScope !== agentScopeKey) {
    setDefaultApplyScope(agentScopeKey);
    return { day: defaultDay.day, range: dayRange(defaultDay.day, coverageZone) };
  }
  return null;
}

/** The observer writes a debounced URL, not mirrored parent-owned playback state. */
function useRecallLocationSync(writeLocation: RecallViewProps["onStateChange"], state: RecallLocation, ready: boolean) {
  const latestWriter = useRef(writeLocation);
  useEffect(() => { latestWriter.current = writeLocation; });
  const { day, atMs, monitor } = state;
  useEffect(() => {
    if (!ready) return;
    // External browser-location synchronization; the writer owns debounce cleanup.
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent, react-doctor/no-pass-live-state-to-parent, react-doctor/no-prop-callback-in-effect
    latestWriter.current?.({ day, atMs, monitor });
  }, [day, atMs, monitor, ready]);
}

function recallDisplay(state: {
  frames: ScreenFrame[]; frameTimes: number[]; activity: { points: ActivityPoint[]; bucketSecs: number } | null;
  frameComplete: boolean | null; loadingFrames: boolean; error: string | null; loadedScope: string; frameScope: string; monitorsScope: string; windowScope: string;
  loadedDayScope: string; dayScope: string; dayTimezone: string | null; identityReady: boolean; selectedFrameId: number | null; playheadMs: number;
  emptyMessage?: string; agentOnline?: boolean; coverageDays: Parameters<typeof latestRecordedDay>[0] | null; summaryDay: string; coverageZone: string | null;
}) {
  const current = state.loadedScope === state.frameScope;
  const loadingPlayback = state.loadingFrames || state.monitorsScope !== state.windowScope || (!current && !state.error);
  let rangeStatus: string;
  const count = (n: number) => `${n.toLocaleString()} ${n === 1 ? "capture" : "captures"}`;
  if (loadingPlayback) rangeStatus = `Loading… ${count(current ? state.frames.length : 0)} so far`;
  else if (state.error) rangeStatus = "Loading failed; the captures shown may be partial";
  else if (state.frameComplete === true) rangeStatus = `${count(state.frames.length)} loaded`;
  else if (state.frameComplete === false) rangeStatus = `${count(state.frames.length)} loaded; this range is incomplete`;
  else rangeStatus = `${count(state.frames.length)} loaded; the server doesn't say whether the range is complete`;
  const displayedFrame = current && !state.loadingFrames && state.identityReady
    ? (state.frames.find(frame => frame.id === state.selectedFrameId && Date.parse(frame.captured_at) === state.playheadMs)
      ?? state.frames[frameIndexAt(state.frameTimes, state.playheadMs)]) ?? null : null;
  return {
    visibleFrames: current ? state.frames : [], visibleActivity: current ? state.activity : null, loadingPlayback, rangeStatus,
    rangeNeedsAttention: !loadingPlayback && (Boolean(state.error) || state.frameComplete !== true), displayedFrame,
    navigationTimezone: state.loadedDayScope === state.dayScope ? state.dayTimezone : null,
    playbackEmptyMessage: state.emptyMessage ?? describeEmptyRange({ online: state.agentOnline ?? null, days: state.coverageDays, day: state.summaryDay, today: todayIso(state.coverageZone ?? undefined) }),
  };
}
