import "./recall.css";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, SegmentedControl, SpaceBetween } from "../ui/console";
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
import { RecallSearch } from "./RecallSearch";
import { todayIso, dayIn, dayRange } from "./recallFormat";

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
  onStateChange,
  children,
}: RecallViewProps) {
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

  const [frames, setFrames] = useState<ScreenFrame[]>([]);
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
  const dayScope = `${agentId}:${summaryDay}`;
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
  const pendingPlayhead = useRef<number | null>(initialAtIso && Number.isFinite(Date.parse(initialAtIso)) ? Date.parse(initialAtIso) : null);

  /** Reload and preset changes re-anchor the window at now. */
  const resetRange = useCallback(() => {
    pendingPlayhead.current = null;
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
    setSummaryDay(initialDay ?? (initialAtIso ? dayIn(null, Date.parse(initialAtIso)) : todayIso()));
    setMonitor(initialMonitor ?? null);
    setFrames([]);
    setActivity(null);
    setDaySummary(null);
    setSegments([]);
    setDayTimezone(null);
    setError(null);
    setMonitors([]);
  }, [agentId, initialMonitor, initialDay, initialAtIso]);

  const windowScope = `${agentId}:${range?.fromMs}:${range?.toMs}`;
  const frameScope = `${windowScope}:${monitor}`;
  const [monitorsScope, setMonitorsScope] = useState("");
  const [loadedScope, setLoadedScope] = useState("");

  // ── Which displays exist in this window ─────────────────────────────────────
  useEffect(() => {
    if (!agentId || !range) return;
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
  }, [agentId, range, windowScope]);

  // ── Frames + activity for the window ────────────────────────────────────────
  // `monitor` is deliberately a dependency: changing displays reloads, because the
  // two screens have entirely different keyframe sets.
  useEffect(() => {
    if (!agentId || !range || monitorsScope !== windowScope) return;
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
  }, [agentId, range, monitor, monitorsScope, windowScope, frameScope]);

  // ── Day narrative + segments ────────────────────────────────────────────────
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    setDaySummary(null);
    setSegments([]);
    setLoadingDay(true);
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
      })
      .finally(() => alive && setLoadingDay(false));
    return () => {
      alive = false;
    };
  }, [agentId, summaryDay, dayScope]);

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
            timezone: dayTimezone,
            loading: loadingDay || loadedDayScope !== dayScope,
            onSeek: seekToIso,
          }
        : null,
    [agentId, summaryDay, daySummary, segments, dayTimezone, loadingDay, seekToIso, changeDay, loadedDayScope, dayScope],
  );

  if (!agentId) {
    return (
      <SpaceBetween size="l">
        {agentPicker}
        <Box color="text-body-secondary">
          {emptyMessage ?? "Select an agent to replay its screen history."}
        </Box>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <div className="recall-controls" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
        {agentPicker}
        <div>
          <Box fontSize="body-s" color="text-body-secondary" margin={{ bottom: "xxs" }}>
            Range
          </Box>
          <SegmentedControl
            selectedId={preset}
            onChange={({ detail }) => setPreset(detail.selectedId as RangePreset)}
            options={[
              { id: "6h", text: "Last 6h" },
              { id: "24h", text: "Last 24h" },
              { id: "7d", text: "Last 7d" },
            ]}
          />
        </div>
        <Button iconName="refresh" onClick={resetRange} disabled={loadingFrames}>
          Reload
        </Button>
      </div>

      <RecallSearch key={`${agentId}:${monitor}`} agentId={agentId} monitor={monitor} onSeek={seekToIso} timezone={dayTimezone} />

      {error && (
        <Alert type="error" header="Recall">
          {error}
        </Alert>
      )}

      <Box fontSize="body-s" color="text-body-secondary">
        {loadingFrames || monitorsScope !== windowScope || (loadedScope !== frameScope && !error)
          ? `Loading screen history… ${loadedScope === frameScope ? frames.length : 0} frames loaded.`
          : error ? "Screen history loading failed; any loaded frames may be partial."
          : frameComplete === true ? `${frames.length} frames loaded for this range.`
          : frameComplete === false ? "Partial screen history loaded; this range is incomplete."
          : "Screen history loaded; this server does not report whether the range is complete."}
      </Box>

      <RecallPlayer
        key={`${agentId}:${monitor}`}
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
        onMonitorChange={(next) => { pendingPlayhead.current = playheadMs; setMonitor(next); }}
        emptyMessage={emptyMessage}
      />

      {children && dayContext ? children(dayContext) : null}
    </SpaceBetween>
  );
}
