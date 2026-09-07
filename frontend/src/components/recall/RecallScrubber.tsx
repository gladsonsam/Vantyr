import { useCallback, useMemo, useRef, useState } from "react";
import type { ActivityPoint, ScreenFrame } from "../../lib/types";
import { api } from "../../lib/api";
import { shortDateIn, timeWithSecondsIn } from "./recallFormat";

/**
 * A gap longer than this is drawn as an explicit hole in the coverage bar rather
 * than as recorded time. Capture forces a keyframe every few minutes even on an
 * unchanged screen, so a gap past this means the machine was off, asleep, or not
 * capturing — which is information, not something to paper over.
 */
const GAP_MS = 4 * 60 * 1000;

/** Thumbnail width requested for the hover preview (snaps server-side). */
const PREVIEW_W = 320;

interface RecallScrubberProps {
  agentId: string;
  frames: ScreenFrame[];
  /** The window the track spans, in epoch ms. */
  fromMs: number;
  toMs: number;
  /** Current playhead, epoch ms. */
  playheadMs: number;
  onSeek: (ms: number) => void;
  /** Keyframe-density histogram, drawn behind the coverage bar. */
  activity: { points: ActivityPoint[]; bucketSecs: number } | null;
  timezone: string | null;
  disabled?: boolean;
}

/**
 * Time-based transport for the Recall player.
 *
 * The scrubber this replaces was indexed over the frame *array*, which made its
 * position meaningless: frames are captured on change, not on a clock, so half the
 * slider could be one idle hour and the other half eight busy ones. It also
 * disagreed with the activity strip directly beneath it, which was already drawn in
 * real time.
 *
 * Everything here is in real time, so the scrubber, the activity histogram, the
 * filmstrip and the day ribbon all describe the same axis. Stretches with no
 * coverage are drawn as gaps, so "nothing was recorded here" is visible instead of
 * being silently stretched over.
 */
export function RecallScrubber({
  agentId,
  frames,
  fromMs,
  toMs,
  playheadMs,
  onSeek,
  activity,
  timezone,
  disabled,
}: RecallScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ ms: number; x: number; frame: ScreenFrame | null } | null>(
    null,
  );
  const dragging = useRef(false);

  const span = Math.max(1, toMs - fromMs);
  const pct = useCallback((ms: number) => ((ms - fromMs) / span) * 100, [fromMs, span]);

  /**
   * Contiguous covered stretches, merged across sub-`GAP_MS` frame spacing.
   *
   * Built once per frame set rather than drawing one element per frame: a loaded
   * range can hold thousands of keyframes, and a few hundred DOM nodes per repaint
   * would make dragging the playhead stutter.
   */
  const runs = useMemo(() => {
    if (frames.length === 0) return [];
    const out: { start: number; end: number }[] = [];
    let start = new Date(frames[0].captured_at).getTime();
    let prev = start;
    for (let i = 1; i < frames.length; i++) {
      const t = new Date(frames[i].captured_at).getTime();
      if (t - prev > GAP_MS) {
        out.push({ start, end: prev });
        start = t;
      }
      prev = t;
    }
    out.push({ start, end: prev });
    return out;
  }, [frames]);

  /** Activity histogram bars, normalized against the busiest bucket. */
  const bars = useMemo(() => {
    if (!activity || activity.points.length === 0 || !activity.bucketSecs) return [];
    const max = activity.points.reduce((m, p) => Math.max(m, p.count), 1);
    const widthPct = (activity.bucketSecs * 1000 * 100) / span;
    return activity.points.map((p) => ({
      t: p.t * 1000,
      ratio: p.count / max,
      widthPct,
    }));
  }, [activity, span]);

  /** Day boundaries in the agent's zone, as tick marks on multi-day ranges. */
  const dayTicks = useMemo(() => {
    const DAY = 24 * 3600 * 1000;
    if (span > 60 * DAY) return [];
    const ticks: number[] = [];
    // Step from local midnight after `fromMs`. Walking in fixed 24h hops would
    // drift across a DST boundary, so each step is re-derived from the date string.
    const startOfNext = new Date(fromMs);
    startOfNext.setHours(24, 0, 0, 0);
    for (let t = startOfNext.getTime(); t < toMs && ticks.length < 64; ) {
      ticks.push(t);
      const d = new Date(t);
      d.setHours(24, 0, 0, 0);
      t = d.getTime();
    }
    return ticks;
  }, [fromMs, toMs, span]);

  /** The frame nearest `ms` (at-or-before, else the first after) for the preview. */
  const frameNear = useCallback(
    (ms: number): ScreenFrame | null => {
      if (frames.length === 0) return null;
      let lo = 0;
      let hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (new Date(frames[mid].captured_at).getTime() < ms) lo = mid + 1;
        else hi = mid;
      }
      const prev = Math.max(0, lo - 1);
      const dLo = Math.abs(new Date(frames[lo].captured_at).getTime() - ms);
      const dPrev = Math.abs(new Date(frames[prev].captured_at).getTime() - ms);
      return dPrev <= dLo ? frames[prev] : frames[lo];
    },
    [frames],
  );

  const msAtClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return playheadMs;
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
      return fromMs + ratio * span;
    },
    [fromMs, span, playheadMs],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    // Pointer capture keeps the drag alive when the cursor leaves the track, so a
    // fast scrub past either end doesn't strand the playhead mid-gesture.
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(msAtClientX(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ms = msAtClientX(e.clientX);
    const el = trackRef.current;
    const x = el ? e.clientX - el.getBoundingClientRect().left : 0;
    setHover({ ms, x, frame: frameNear(ms) });
    if (dragging.current) onSeek(ms);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const playPct = Math.min(100, Math.max(0, pct(playheadMs)));

  return (
    <div style={{ padding: "4px 2px 0" }}>
      {/* Track: activity behind, coverage in front, playhead on top. */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Playhead"
        aria-valuemin={fromMs}
        aria-valuemax={toMs}
        aria-valuenow={playheadMs}
        aria-valuetext={timeWithSecondsIn(timezone, playheadMs)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        style={{
          position: "relative",
          height: 46,
          borderRadius: 8,
          background: "var(--bg-2, rgba(255,255,255,0.02))",
          cursor: disabled ? "default" : "pointer",
          touchAction: "none",
          overflow: "hidden",
        }}
      >
        {/* Keyframe density — how interactive the machine was, minute to minute. */}
        {bars.map((b) => (
          <span
            key={b.t}
            style={{
              position: "absolute",
              left: `${pct(b.t)}%`,
              width: `${Math.max(0.15, b.widthPct)}%`,
              bottom: 10,
              height: `${6 + b.ratio * 28}px`,
              background: "var(--gr)",
              opacity: 0.14 + b.ratio * 0.4,
              borderRadius: 1,
              pointerEvents: "none",
            }}
          />
        ))}

        {/* Coverage: solid where frames exist, bare track where nothing was recorded. */}
        <span
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 4,
            height: 4,
            borderRadius: 2,
            background: "var(--line)",
            pointerEvents: "none",
          }}
        />
        {runs.map((r) => (
          <span
            key={r.start}
            style={{
              position: "absolute",
              left: `${pct(r.start)}%`,
              width: `${Math.max(0.4, pct(r.end) - pct(r.start))}%`,
              bottom: 4,
              height: 4,
              borderRadius: 2,
              background: "var(--gr)",
              opacity: 0.75,
              pointerEvents: "none",
            }}
          />
        ))}

        {/* Local midnights, so a multi-day range reads as days rather than one smear. */}
        {dayTicks.map((t) => (
          <span
            key={t}
            style={{
              position: "absolute",
              left: `${pct(t)}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--line)",
              opacity: 0.9,
              pointerEvents: "none",
            }}
          />
        ))}

        {/* Playhead */}
        <span
          style={{
            position: "absolute",
            left: `${playPct}%`,
            top: 2,
            bottom: 2,
            width: 2,
            marginLeft: -1,
            background: "var(--tx)",
            borderRadius: 2,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
            pointerEvents: "none",
          }}
        />

        {/* Hover time marker (the preview thumbnail sits outside the clipped track). */}
        {hover && !disabled && (
          <span
            style={{
              position: "absolute",
              left: `${pct(hover.ms)}%`,
              top: 2,
              bottom: 2,
              width: 1,
              background: "var(--tx-3)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      {/* Hover preview — the point of the thumbnail endpoint: seeing where you're
          about to land without fetching a full keyframe per pixel of travel. */}
      {hover && !disabled && (
        <div
          style={{
            position: "relative",
            height: 0,
            // Anchored under the cursor and clamped so the card never overflows the
            // player's edges at either end of the track.
            marginLeft: Math.max(0, hover.x - 84),
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 4,
              width: 168,
              padding: 4,
              borderRadius: 8,
              background: "var(--card)",
              border: "1px solid var(--line)",
              boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            {hover.frame ? (
              <img
                src={api.historyBlobUrl(agentId, hover.frame.id, PREVIEW_W)}
                alt=""
                style={{ display: "block", width: "100%", borderRadius: 5 }}
              />
            ) : null}
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10.5,
                color: "var(--tx-2)",
                textAlign: "center",
                paddingTop: 3,
              }}
            >
              {timeWithSecondsIn(timezone, hover.ms)}
            </div>
          </div>
        </div>
      )}

      {/* Range bounds */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          color: "var(--tx-3)",
          paddingTop: 4,
        }}
      >
        <span>{shortDateIn(timezone, fromMs)}</span>
        <span>{shortDateIn(timezone, toMs)}</span>
      </div>
    </div>
  );
}
