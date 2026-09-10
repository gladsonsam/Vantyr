import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, SegmentedControl, Spinner } from "../ui/console";
import { api } from "../../lib/api";
import type { ActivityPoint, HistoryMonitor, OcrWord, ScreenFrame } from "../../lib/types";
import { RecallFilmstrip } from "./RecallFilmstrip";
import { advancePlayhead, frameIndexAt } from "./recallPlayback";
import { RecallScrubber } from "./RecallScrubber";
import { shortDateIn, timeWithSecondsIn } from "./recallFormat";

/**
 * Playback speeds as *time compression*, not as frame cadence.
 *
 * The player this replaces advanced one frame per tick, so an overnight gap played
 * at exactly the same speed as a busy minute and the speed control said nothing
 * about how much history you were covering. Rates are history-seconds per
 * wall-second, labelled as what they actually do.
 */
const SPEEDS = [
  { id: "1m", text: "1m/s", rate: 60 },
  { id: "5m", text: "5m/s", rate: 300 },
  { id: "30m", text: "30m/s", rate: 1800 },
];

/** Playback tick. Fixed and short; the *rate* decides how much history each tick covers. */
const TICK_MS = 100;

/**
 * Floor on how long the playhead lingers past a frame before an idle gap is
 * skipped. Scaled by the current rate so gap-skipping means the same thing at every
 * speed — a fixed threshold would make the fastest rate skip constantly.
 */
const MIN_HOLD_MS = 30_000;

interface RecallPlayerProps {
  agentId: string;
  frames: ScreenFrame[];
  /** The window `frames` covers, in epoch ms. */
  fromMs: number;
  toMs: number;
  playheadMs: number;
  onSeek: (ms: number) => void;
  loading: boolean;
  activity: { points: ActivityPoint[]; bucketSecs: number } | null;
  timezone: string | null;
  /** Displays recorded in this range; a picker only appears when there are several. */
  monitors: HistoryMonitor[];
  monitor: number | null;
  onMonitorChange: (monitor: number) => void;
  /** Rendered when the range holds no frames at all. */
  emptyMessage?: string;
}

/**
 * Recall DVR player: stage, selectable-text overlay, time-based transport.
 *
 * The playhead is real time and lives in the parent, so search hits, day segments
 * and highlights can all seek it and every timeline in the view agrees on where
 * "now" is.
 */
export function RecallPlayer({
  agentId,
  frames,
  fromMs,
  toMs,
  playheadMs,
  onSeek,
  loading,
  activity,
  timezone,
  monitors,
  monitor,
  onMonitorChange,
  emptyMessage,
}: RecallPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [speedId, setSpeedId] = useState("5m");
  const [showText, setShowText] = useState(false);
  const [words, setWords] = useState<OcrWord[]>([]);
  const [imgHeight, setImgHeight] = useState(0);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const rate = useMemo(() => SPEEDS.find((s) => s.id === speedId)?.rate ?? 300, [speedId]);

  /** Frame timestamps, cached: every seek and every playback tick binary-searches them. */
  const times = useMemo(() => frames.map((f) => new Date(f.captured_at).getTime()), [frames]);

  const indexAt = useCallback((ms: number) => frameIndexAt(times, ms), [times]);

  const index = indexAt(playheadMs);
  const current: ScreenFrame | undefined = index >= 0 ? frames[index] : undefined;

  const blobUrl = useMemo(
    () => (current ? api.historyBlobUrl(agentId, current.id) : null),
    [agentId, current],
  );

  // ── Playback ────────────────────────────────────────────────────────────────
  // Advance the playhead in real time and skip idle gaps, rather than stepping one
  // frame per tick. `playheadRef` carries the value into the interval so the timer
  // isn't torn down and rebuilt on every tick.
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const perTick = TICK_MS * rate;
    const holdMs = Math.max(perTick * 1.5, MIN_HOLD_MS);
    const timer = setInterval(() => {
      const { playheadMs: next, ended } = advancePlayhead({
        times,
        playheadMs: playheadRef.current,
        perTickMs: perTick,
        holdMs,
        toMs,
      });
      if (ended) setPlaying(false);
      onSeek(next);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, frames.length, rate, times, toMs, onSeek]);

  const togglePlay = useCallback(() => {
    if (frames.length === 0) return;
    // Restart from the first frame when parked at the end.
    if (!playing && playheadMs >= times[times.length - 1]) onSeek(times[0]);
    setPlaying((p) => !p);
  }, [frames.length, playing, playheadMs, times, onSeek]);

  const step = useCallback(
    (delta: number) => {
      if (times.length === 0) return;
      setPlaying(false);
      const i = indexAt(playheadMs);
      const next = Math.min(times.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
      onSeek(times[next]);
    },
    [times, indexAt, playheadMs, onSeek],
  );

  const nudge = useCallback(
    (deltaMs: number) => {
      setPlaying(false);
      onSeek(Math.min(toMs, Math.max(fromMs, playheadMs + deltaMs)));
    },
    [playheadMs, fromMs, toMs, onSeek],
  );

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  // ── Keyboard transport ──────────────────────────────────────────────────────
  // Window-level so the shortcuts work without hunting for something to focus, but
  // inert while the operator is typing — Recall's search box is right above this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          step(1);
          break;
        case "j":
          nudge(-60_000);
          break;
        case "l":
          nudge(60_000);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "t":
          setShowText((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, step, nudge, toggleFullscreen]);

  // Stop playing when the loaded window changes under us (range switch, monitor
  // switch, jump-to-search-hit) — resuming into unrelated frames is disorienting.
  useEffect(() => {
    setPlaying(false);
  }, [fromMs, toMs, monitor, agentId]);

  // ── Selectable text overlay ─────────────────────────────────────────────────
  // Word boxes for the frame on screen. Fetched per frame rather than with the range
  // listing: 3000 frames' worth of word geometry would dwarf the metadata it rides
  // on. Skipped during playback — nobody selects text off a moving timelapse, and it
  // would fire a request per frame.
  useEffect(() => {
    if (!current || playing || !current.has_ocr || !showText) {
      setWords([]);
      return;
    }
    let alive = true;
    api
      .historyFrameText(agentId, current.id)
      .then((res) => alive && setWords(res.words ?? []))
      .catch(() => alive && setWords([]));
    return () => {
      alive = false;
    };
  }, [agentId, current, playing, showText]);

  // Track the image's rendered height so overlay glyphs scale with it (window
  // resize, sidebar collapse, letterboxing changes).
  useEffect(() => {
    const el = imgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setImgHeight(el.clientHeight));
    ro.observe(el);
    setImgHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [blobUrl, showText]);

  // ── Decode-ahead ────────────────────────────────────────────────────────────
  // Each frame is a separate HTTP fetch, so at speed playback outruns the network
  // and stutters. Warm the browser cache for the frames just ahead of the playhead;
  // the blob endpoint sends a long private max-age, so by the time the <img> src
  // flips the bytes are already local.
  const prefetched = useRef<Set<number>>(new Set());
  useEffect(() => {
    prefetched.current = new Set();
  }, [fromMs, toMs, agentId, monitor]);
  useEffect(() => {
    if (frames.length === 0 || index < 0) return;
    // Look further ahead at higher rates, since each tick covers more history.
    const ahead = playing ? Math.max(6, Math.round(rate / 40)) : 3;
    for (let i = index + 1; i <= index + ahead && i < frames.length; i++) {
      const id = frames[i].id;
      if (prefetched.current.has(id)) continue;
      prefetched.current.add(id);
      // Fire-and-forget: the Image is only a cache warmer, never rendered.
      const img = new Image();
      img.decoding = "async";
      img.src = api.historyBlobUrl(agentId, id);
    }
    // Bound the memo set so a long scrub can't grow it without limit.
    if (prefetched.current.size > 2000) prefetched.current = new Set();
  }, [agentId, frames, index, playing, rate, monitor]);

  const monitorOptions = useMemo(
    () =>
      monitors.map((m) => ({
        id: String(m.monitor),
        text: monitors.length > 1 ? `Display ${m.monitor + 1}` : "Display",
      })),
    [monitors],
  );

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {/* Stage */}
      <div
        ref={stageRef}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {loading ? (
          <Spinner size="large" />
        ) : blobUrl ? (
          // The wrapper shrink-wraps the letterboxed image so the word overlay
          // shares its exact box — percentage coordinates then line up with the
          // pixels regardless of how the 16:9 stage letterboxes the frame.
          <div
            style={{
              position: "relative",
              display: "inline-block",
              maxWidth: "100%",
              maxHeight: "100%",
            }}
          >
            <img
              ref={imgRef}
              src={blobUrl}
              alt={`Screen at ${current?.captured_at ?? ""}`}
              onLoad={(e) => setImgHeight(e.currentTarget.clientHeight)}
              style={{
                display: "block",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
            {showText && words.length > 0 && (
              <div
                // Transparent, selectable text laid over the screenshot: drag to
                // select and copy text off a screen from weeks ago. Each span is
                // scaled to fill its box so selection highlights land on the
                // actual glyphs rather than floating above them.
                style={{ position: "absolute", inset: 0, cursor: "text", userSelect: "text" }}
              >
                {words.map((w, i) => (
                  <span
                    key={i}
                    style={{
                      position: "absolute",
                      left: `${w.x * 100}%`,
                      top: `${w.y * 100}%`,
                      width: `${w.w * 100}%`,
                      height: `${w.h * 100}%`,
                      // Absolute px from the box height and the image's rendered
                      // height — a percentage font-size would resolve against the
                      // parent's font, not the box, and glyphs would drift out of
                      // alignment with the pixels underneath.
                      fontSize: `${Math.max(1, w.h * imgHeight)}px`,
                      lineHeight: 1,
                      color: "transparent",
                      whiteSpace: "pre",
                      overflow: "hidden",
                    }}
                  >
                    {w.t}{" "}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Box textAlign="center" color="text-body-secondary" padding={{ vertical: "xxl" }}>
            {emptyMessage ?? "No screen history in this range yet."}
          </Box>
        )}

        {/* Playhead clock, over the frame so it stays readable in fullscreen. */}
        {current && (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 12,
              padding: "4px 9px",
              borderRadius: 7,
              background: "rgba(0,0,0,0.62)",
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "#eceef1",
              pointerEvents: "none",
            }}
          >
            {shortDateIn(timezone, playheadMs)} · {timeWithSecondsIn(timezone, playheadMs)}
          </div>
        )}
      </div>

      {/* Transport */}
      <div style={{ padding: "10px 14px 12px", borderTop: "1px solid var(--line)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 6,
          }}
        >
          <Button
            variant="primary"
            onClick={togglePlay}
            disabled={frames.length === 0}
            ariaLabel={playing ? "Pause (space)" : "Play (space)"}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button onClick={() => step(-1)} disabled={frames.length === 0} ariaLabel="Previous frame">
            ‹
          </Button>
          <Button onClick={() => step(1)} disabled={frames.length === 0} ariaLabel="Next frame">
            ›
          </Button>
          <SegmentedControl
            selectedId={speedId}
            onChange={({ detail }) => setSpeedId(detail.selectedId)}
            options={SPEEDS.map((s) => ({ id: s.id, text: s.text }))}
          />
          {monitorOptions.length > 1 && (
            <SegmentedControl
              selectedId={String(monitor ?? monitors[0]?.monitor ?? 0)}
              onChange={({ detail }) => onMonitorChange(Number(detail.selectedId))}
              options={monitorOptions}
            />
          )}
          <div style={{ flex: 1 }} />
          <Button
            onClick={() => setShowText((v) => !v)}
            disabled={!current?.has_ocr}
            ariaLabel={showText ? "Hide selectable text (t)" : "Select text on this frame (t)"}
          >
            {showText ? "Done" : "Select text"}
          </Button>
          <Button onClick={toggleFullscreen} ariaLabel="Fullscreen (f)">
            Fullscreen
          </Button>
        </div>

        <RecallScrubber
          agentId={agentId}
          frames={frames}
          fromMs={fromMs}
          toMs={toMs}
          playheadMs={playheadMs}
          onSeek={(ms) => {
            setPlaying(false);
            onSeek(ms);
          }}
          activity={activity}
          timezone={timezone}
          disabled={frames.length === 0}
        />

        <div style={{ marginTop: 10 }}>
          <RecallFilmstrip
            agentId={agentId}
            frames={frames}
            playheadMs={playheadMs}
            onSeek={(ms) => {
              setPlaying(false);
              onSeek(ms);
            }}
            timezone={timezone}
          />
        </div>

        <div
          style={{
            fontSize: 11,
            color: "var(--tx-3)",
            paddingTop: 8,
          }}
        >
          Space play/pause · ←/→ frame · J/L ±1 min · F fullscreen · T select text
        </div>
      </div>
    </div>
  );
}
