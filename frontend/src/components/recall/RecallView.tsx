import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, SegmentedControl, SpaceBetween } from "../ui/console";
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
import { todayIso } from "./recallFormat";

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
export function RecallView({ agentId, agentPicker, emptyMessage, children }: RecallViewProps) {
  const [preset, setPreset] = useState<RangePreset>("24h");
  // The window currently loaded. Set by the preset, by Reload, and by jumps that
  // land outside it; kept in state rather than derived so a jump can widen it.
  const [range, setRange] = useState<{ fromMs: number; toMs: number } | null>(null);
  const [playheadMs, setPlayheadMs] = useState<number>(() => Date.now());

  const [frames, setFrames] = useState<ScreenFrame[]>([]);
  const [activity, setActivity] = useState<{ points: ActivityPoint[]; bucketSecs: number } | null>(
    null,
  );
  const [monitors, setMonitors] = useState<HistoryMonitor[]>([]);
  const [monitor, setMonitor] = useState<number | null>(null);

  const [summaryDay, setSummaryDay] = useState<string>(todayIso());
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [segments, setSegments] = useState<ActivitySegment[]>([]);
  // The agent's IANA zone, reported alongside the day. Day rows are bucketed in the
  // agent's local day, so times must be rendered in it too — otherwise an operator in
  // a different zone sees a session list that contradicts the date above it.
  const [dayTimezone, setDayTimezone] = useState<string | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);

  const [loadingFrames, setLoadingFrames] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Reset the window to the selected preset, ending at now. */
  const resetRange = useCallback(() => {
    const toMs = Date.now();
    setRange({ fromMs: toMs - RANGE_MS[preset], toMs });
  }, [preset]);

  // A new agent or preset re-anchors the window on the present.
  useEffect(() => {
    resetRange();
  }, [agentId, resetRange]);

  // Switching agents invalidates the display selection: display indices are
  // per-machine, so carrying "Display 2" across would silently pick a different screen.
  useEffect(() => {
    setMonitor(null);
    setMonitors([]);
  }, [agentId]);

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
      .catch(() => alive && setMonitors([]));
    return () => {
      alive = false;
    };
  }, [agentId, range]);

  // ── Frames + activity for the window ────────────────────────────────────────
  // `monitor` is deliberately a dependency: changing displays reloads, because the
  // two screens have entirely different keyframe sets.
  const pendingPlayhead = useRef<number | null>(null);
  useEffect(() => {
    if (!agentId || !range) return;
    let alive = true;
    setLoadingFrames(true);
    setError(null);
    const from = new Date(range.fromMs).toISOString();
    const to = new Date(range.toMs).toISOString();
    api
      .historyFrames(agentId, { from, to, monitor, limit: FRAME_LIMIT })
      .then((res) => {
        if (!alive) return;
        setFrames(res.frames);
        if (res.frames.length === 0) return;
        const first = new Date(res.frames[0].captured_at).getTime();
        const last = new Date(res.frames[res.frames.length - 1].captured_at).getTime();
        // A jump that had to widen the window asked for a specific instant; honour
        // it now that its frames are here. Otherwise park on the newest frame.
        const want = pendingPlayhead.current;
        pendingPlayhead.current = null;
        setPlayheadMs(want != null ? Math.min(last, Math.max(first, want)) : last);
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
  }, [agentId, range, monitor]);

  // ── Day narrative + segments ────────────────────────────────────────────────
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    setLoadingDay(true);
    Promise.all([
      api.historyDaySummary(agentId, summaryDay),
      api.historySegments(agentId, summaryDay),
    ])
      .then(([sum, segs]) => {
        if (!alive) return;
        setDaySummary(sum.summary);
        setSegments(segs.segments);
        setDayTimezone(sum.timezone ?? segs.timezone ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setDaySummary(null);
        setSegments([]);
      })
      .finally(() => alive && setLoadingDay(false));
    return () => {
      alive = false;
    };
  }, [agentId, summaryDay]);

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
      if (!range) return;
      if (ms >= range.fromMs && ms <= range.toMs) {
        setPlayheadMs(ms);
        return;
      }
      pendingPlayhead.current = ms;
      setRange({ fromMs: ms - JUMP_PAD_MS, toMs: ms + JUMP_PAD_MS });
    },
    [range],
  );

  const seekToIso = useCallback((iso: string) => seekTo(new Date(iso).getTime()), [seekTo]);

  const dayContext: RecallDayContext | null = useMemo(
    () =>
      agentId
        ? {
            agentId,
            day: summaryDay,
            onDayChange: setSummaryDay,
            summary: daySummary,
            segments,
            timezone: dayTimezone,
            loading: loadingDay,
            onSeek: seekToIso,
          }
        : null,
    [agentId, summaryDay, daySummary, segments, dayTimezone, loadingDay, seekToIso],
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
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

      <RecallSearch agentId={agentId} monitor={monitor} onSeek={seekToIso} timezone={dayTimezone} />

      {error && (
        <Alert type="error" header="Recall">
          {error}
        </Alert>
      )}

      <RecallPlayer
        agentId={agentId}
        frames={frames}
        fromMs={range?.fromMs ?? Date.now() - RANGE_MS[preset]}
        toMs={range?.toMs ?? Date.now()}
        playheadMs={playheadMs}
        onSeek={setPlayheadMs}
        loading={loadingFrames}
        activity={activity}
        timezone={dayTimezone}
        monitors={monitors}
        monitor={monitor}
        onMonitorChange={setMonitor}
        emptyMessage={emptyMessage}
      />

      {children && dayContext ? children(dayContext) : null}
    </SpaceBetween>
  );
}
