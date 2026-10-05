import "./recall.css";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { loadFramePages } from "../../lib/recallPaging";
import { api, errorText } from "../../lib/api";
import type {
  ActivityPoint,
  ActivitySegment,
  DaySummary,
  HistoryMonitor,
  ScreenFrame,
} from "../../lib/types";
import { RecallPlayer } from "./RecallPlayer";
import { RecallNavigation } from "./RecallNavigation";
import { frameIndexAt } from "./recallPlayback";
import type { SavedSearch } from "./recallRetrieval";
import { useRecallPreferenceKey } from "../../hooks/useRecallPreferenceKey";
import { RecallSearch } from "./RecallSearch";
import { todayIso, dayIn, dayRange, shortDateIn, timeWithSecondsIn } from "./recallFormat";

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

/**
 * The Recall DVR, minus the page chrome.
 *
 * Split out of `RecallPage` so the same view can be embedded on an agent's own
 * detail page with the picker replaced by that agent. Recall being reachable only
 * from a standalone page with its own device picker was most of why it felt bolted
 * on: nothing in the rest of the dashboard could link *into* it.
 *
 * Owns the loaded window, the playhead and the display selection. The playhead is a
 * real timestamp, so search hits, segments and highlights all seek by time and every
 * strip in the view describes the same axis.
 */
export function RecallView({
  agentId,
  agentPicker,
  emptyMessage,
  initialAtIso,
  initialDay,
  initialMonitor,
  initialSearch, initialSearchError, onSearchStateChange,
  onStateChange,
  children,
}: RecallViewProps) {
  const preferencesKey=useRecallPreferenceKey(agentId);
  const [searchDraft,setSearchDraft]=useState<{agent:string|null;value:SavedSearch|null}>({agent:agentId,value:initialSearch ?? null});
  const searchState=searchDraft.agent===agentId ? searchDraft.value : initialSearch ?? null;
  const changeSearchState=useCallback((search:SavedSearch|null)=>{setSearchDraft({agent:agentId,value:search});onSearchStateChange?.(search);},[agentId,onSearchStateChange]);
  const identityReady=typeof api.me!=="function"||Boolean(preferencesKey);
  const [preset, setPreset] = useState<RangePreset>("24h");
  // The window currently loaded. Set by the preset, by Reload, and by jumps that
  // land outside it; kept in state rather than derived so a jump can widen it.
  const [range, setRange] = useState<{ fromMs: number; toMs: number }>(() => {
    const at = initialAtIso ? Date.parse(initialAtIso) : NaN;
    if (Number.isFinite(at)) return { fromMs: at - JUMP_PAD_MS, toMs: at + JUMP_PAD_MS };
    if (initialDay) return dayRange(initialDay, null);
    const toMs = Date.now();
    return { fromMs: toMs - RANGE_MS["24h"], toMs };
  });
  const [playheadMs, setPlayheadMs] = useState<number>(() => Date.now());

  const [selectedFrameId,setSelectedFrameId]=useState<number|null>(null);
  const [frames, setFrames] = useState<ScreenFrame[]>([]);
  const frameTimes = useMemo(() => frames.map(frame => Date.parse(frame.captured_at)), [frames]);
  const [activity, setActivity] = useState<{ points: ActivityPoint[]; bucketSecs: number } | null>(
    null,
  );
  const [monitors, setMonitors] = useState<HistoryMonitor[]>([]);
  const [monitor, setMonitor] = useState<number | null>(initialMonitor ?? null);

  const [summaryDay, setSummaryDay] = useState<string>(initialDay ?? todayIso());
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [segments, setSegments] = useState<ActivitySegment[]>([]);
  // The agent's IANA zone, reported alongside the day. Day rows are bucketed in the
  // agent's local day, so times must be rendered in it too — otherwise an operator in
  // a different zone sees a session list that contradicts the date above it.
  const [dayTimezone, setDayTimezone] = useState<string | null>(null);
  const [loadedDayScope, setLoadedDayScope] = useState("");
  const dayScope = `${preferencesKey}:${agentId}:${summaryDay}`;
  const [dayError, setDayError] = useState(false);
  const [loadingDay, setLoadingDay] = useState(false);

  const [frameComplete, setFrameComplete] = useState<boolean | null>(null);
  const [loadingFrames, setLoadingFrames] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * An instant the next frame load should land on.
   *
   * A jump that had to widen the window can't seek until that window's frames
   * arrive, so the target is parked here and consumed by the load effect.
   */
  const daySourceAllDisplays = useRef(false);
  const pendingPlayhead = useRef<number | null>(initialAtIso && Number.isFinite(Date.parse(initialAtIso)) ? Date.parse(initialAtIso) : null);

  /** Reload and preset changes re-anchor the window at now. */
  const resetRange = useCallback(() => {
    pendingPlayhead.current = null;
    daySourceAllDisplays.current = false;
    const toMs = Date.now();
    setRange({ fromMs: toMs - RANGE_MS[preset], toMs });
  }, [preset]);

  const previousScope = useRef({ agentId, preset });
  useEffect(() => {
    if (previousScope.current.agentId === agentId && previousScope.current.preset === preset) return;
    previousScope.current = { agentId, preset };
    resetRange();
  }, [agentId, preset, resetRange]);

  // Switching agents invalidates the display selection: display indices are
  // per-machine, so carrying "Display 2" across would silently pick a different screen.
  useEffect(() => {
    zoneApplied.current = false;
    daySourceAllDisplays.current = false;
    setSummaryDay(initialDay ?? (initialAtIso ? dayIn(null, Date.parse(initialAtIso)) : todayIso()));
    setMonitor(initialMonitor ?? null);
    setSelectedFrameId(null);
    setFrames([]);
    setActivity(null);
    setDaySummary(null);
    setSegments([]);
    setDayTimezone(null);
    setError(null);
    setMonitors([]);
  }, [agentId, initialMonitor, initialDay, initialAtIso]);

  const windowScope = `${preferencesKey}:${agentId}:${range?.fromMs}:${range?.toMs}`;
  const frameScope = `${windowScope}:${monitor}`;
  const [monitorsScope, setMonitorsScope] = useState("");
  const [loadedScope, setLoadedScope] = useState("");

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
          if (daySourceAllDisplays.current) return null;
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
  }, [agentId, identityReady, range, windowScope]);

  // ── Frames + activity for the window ────────────────────────────────────────
  // `monitor` is deliberately a dependency: changing displays reloads, because the
  // two screens have entirely different keyframe sets.
  useEffect(() => {
    if (!agentId || !identityReady || !range || monitorsScope !== windowScope) return;
    let alive = true;
    setFrames([]);
    setActivity(null);
    setLoadingFrames(true);
    setError(null);
    const from = new Date(range.fromMs).toISOString();
    const to = new Date(range.toMs).toISOString();
    setFrameComplete(null);
    let loadedFrames: ScreenFrame[] = [];
    loadFramePages(
      (cursor) => api.historyFrames(agentId, { from, to, monitor, limit: FRAME_LIMIT, cursor }),
      (progress) => {
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
        const want = pendingPlayhead.current;
        pendingPlayhead.current = null;
        const last = loadedFrames[loadedFrames.length - 1];
        setPlayheadMs(want ?? (last ? Date.parse(last.captured_at) : range.toMs));
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoadingFrames(false));

    api
      .historyActivity(agentId, { from, to, monitor, buckets: 200 })
      .then((res) => alive && setActivity({ points: res.points, bucketSecs: res.bucket_secs }))
      .catch(() => alive && setActivity(null));
    return () => {
      alive = false;
    };
  }, [agentId, identityReady, range, monitor, monitorsScope, windowScope, frameScope]);

  // ── Day narrative + segments ────────────────────────────────────────────────
  useEffect(() => {
    if (!agentId || !identityReady) return;
    let alive = true;
    setDaySummary(null);
    setSegments([]);
    setLoadingDay(true);
    setDayError(false);
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
      .finally(() => alive && setLoadingDay(false));
    return () => {
      alive = false;
    };
  }, [agentId, identityReady, summaryDay, dayScope]);

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
      pendingPlayhead.current = ms;
      setRange({ fromMs: ms - JUMP_PAD_MS, toMs: ms + JUMP_PAD_MS });
    },
    [range, dayTimezone],
  );

  const zoneApplied = useRef(false);
  useEffect(() => {
    if (!dayTimezone || zoneApplied.current) return;
    zoneApplied.current = true;
    if (initialDay) {
      if (!initialAtIso) setRange(dayRange(initialDay, dayTimezone));
    } else {
      setSummaryDay(dayIn(dayTimezone, initialAtIso ? Date.parse(initialAtIso) : Date.now()));
    }
  }, [dayTimezone, initialDay, initialAtIso]);

  const changeDay = useCallback((day: string) => {
    setSummaryDay(day);
    const next = dayRange(day, dayTimezone);
    pendingPlayhead.current = next.fromMs;
    setRange(next);
  }, [dayTimezone]);

  const seekToIso = useCallback((iso: string) => seekTo(new Date(iso).getTime()), [seekTo]);

  // Day evidence describes all displays, so a source jump must not inherit a
  // display filter or a previously selected search frame.
  const seekDaySource = useCallback((iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return;
    setSelectedFrameId(null);
    daySourceAllDisplays.current = true;
    if (monitor !== null) pendingPlayhead.current = ms;
    setMonitor(null);
    seekToIso(iso);
  }, [monitor, seekToIso]);

  // Publish the shareable state so a parent can mirror it into the URL. Every
  // Recall view is then linkable at a specific agent, day, display and moment —
  // without which nothing in the rest of the dashboard could point *into* Recall.
  useEffect(() => {
    if (!range || loadingFrames || loadedScope !== frameScope) return;
    onStateChange?.({ day: summaryDay, atMs: playheadMs, monitor });
  }, [onStateChange, summaryDay, playheadMs, monitor, range, loadingFrames, loadedScope, frameScope]);

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

  if (!agentId) {
    return (
      <div className="flex flex-col gap-6">
        {agentPicker}
        <p className="text-sm text-muted-foreground">
          {emptyMessage ?? "Select an agent to replay its screen history."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="recall-controls flex flex-wrap items-end gap-4">
        {agentPicker}
        <div className="grid min-w-0 gap-1.5">
          <Label>Range</Label>
          <ToggleGroup
            size="sm"
            spacing={0}
            className="rounded-lg bg-muted/70 p-0.5"
            aria-label="Playback range"
            value={[preset]}
            onValueChange={(value) => {
              const next = value[0] as RangePreset | undefined;
              if (!next) return;
              pendingPlayhead.current = null;
              const toMs = Date.now();
              setPreset(next);
              setRange({ fromMs: toMs - RANGE_MS[next], toMs });
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
        </div>
        <Button variant="outline" onClick={resetRange} disabled={loadingFrames}>
          Reload
        </Button>
      </div>

      <RecallSearch key={`search:${agentId}`} agentId={agentId} monitor={monitor} onSeek={(iso, display,id) => { daySourceAllDisplays.current = false; setSelectedFrameId(id??null); if ((display ?? null) !== monitor) pendingPlayhead.current = Date.parse(iso); setMonitor(display ?? null); seekToIso(iso); }} timezone={dayTimezone} range={range} preferencesKey={preferencesKey} initialSearch={searchState} initialSearchError={initialSearchError} onSearchStateChange={changeSearchState} />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Recall</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <p className="text-sm text-muted-foreground">
        Loaded window: {shortDateIn(dayTimezone, range.fromMs)} {timeWithSecondsIn(dayTimezone, range.fromMs)} – {shortDateIn(dayTimezone, range.toMs)} {timeWithSecondsIn(dayTimezone, range.toMs)}. {" "}
        {loadingFrames || monitorsScope !== windowScope || (loadedScope !== frameScope && !error)
          ? `Loading screen history… ${loadedScope === frameScope ? frames.length : 0} frames loaded.`
          : error ? "Screen history loading failed; any loaded frames may be partial."
          : frameComplete === true ? `${frames.length} frames loaded for this range.`
          : frameComplete === false ? "Partial screen history loaded; this range is incomplete."
          : "Screen history loaded; this server does not report whether the range is complete."}
      </p>

      <RecallPlayer
        selectedFrameId={selectedFrameId}
        key={`player:${agentId}:${monitor}`}
        agentId={agentId}
        frames={loadedScope === frameScope ? frames : []}
        fromMs={range?.fromMs ?? Date.now() - RANGE_MS[preset]}
        toMs={range?.toMs ?? Date.now()}
        playheadMs={playheadMs}
        onSeek={(ms) => { setPlayheadMs(ms); setSummaryDay(dayIn(dayTimezone, ms)); }}
        loading={loadingFrames || monitorsScope !== windowScope || (loadedScope !== frameScope && !error) || (loadedScope !== frameScope && !error)}
        activity={loadedScope === frameScope ? activity : null}
        timezone={dayTimezone}
        monitors={monitors}
        monitor={monitor}
        onMonitorChange={(next) => { daySourceAllDisplays.current = false; pendingPlayhead.current = playheadMs; setMonitor(next); }}
        emptyMessage={emptyMessage ?? "No retained recording in this playback range. It may be missing or expired; the reason is unknown. Choose another recorded day or display."}
      />

      <RecallNavigation key={agentId} agentId={agentId} timezone={loadedDayScope === dayScope ? dayTimezone : null} atMs={playheadMs} monitor={monitor}
        displayedFrame={loadedScope === frameScope && !loadingFrames && identityReady ? (frames.find(frame=>frame.id===selectedFrameId&&Date.parse(frame.captured_at)===playheadMs) ?? frames[frameIndexAt(frameTimes, playheadMs)]) ?? null : null}
        preferencesKey={preferencesKey} search={searchState} onSeek={iso => { daySourceAllDisplays.current = false; seekToIso(iso); }} onMonitor={next => { daySourceAllDisplays.current = false; setMonitor(next); }}
        onRange={next => { pendingPlayhead.current = next.fromMs; setRange(next); setSummaryDay(dayIn(dayTimezone, next.fromMs)); }} />
      {children && dayContext ? children(dayContext) : null}
    </div>
  );
}
