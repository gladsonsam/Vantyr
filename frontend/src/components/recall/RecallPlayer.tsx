import { RecallCaptureContext } from "./RecallCaptureContext";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../../lib/api";
import type { ActivityPoint, HistoryMonitor, OcrWord, ScreenFrame } from "../../lib/types";
import { RecallFilmstrip } from "./RecallFilmstrip";
import { advancePlayhead, frameIndexAt } from "./recallPlayback";
import { RecallScrubber } from "./RecallScrubber";
import { formatDuration, shortDateIn, timeWithSecondsIn } from "./recallFormat";

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
  /** A clicked hit may share time/monitor with another keyframe. */
  selectedFrameId?:number|null;
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
  emptyMessage, selectedFrameId,
}: RecallPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [speedId, setSpeedId] = useState("5m");
  const [showText, setShowText] = useState(false);
  const [words, setWords] = useState<OcrWord[]>([]);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [imgHeight, setImgHeight] = useState(0);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const rate = useMemo(() => SPEEDS.find((s) => s.id === speedId)?.rate ?? 300, [speedId]);

  /** Frame timestamps, cached: every seek and every playback tick binary-searches them. */
  const times = useMemo(() => frames.map((f) => new Date(f.captured_at).getTime()), [frames]);

  const indexAt = useCallback((ms: number) => frameIndexAt(times, ms), [times]);

  const target=selectedFrameId == null ? -1 : frames.findIndex(frame=>frame.id===selectedFrameId&&Date.parse(frame.captured_at)===playheadMs);
  const index = target>=0 ? target : indexAt(playheadMs);
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
    if (!playing || loading || frames.length === 0) return;
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
  }, [playing, loading, frames.length, rate, times, toMs, onSeek]);

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
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || el?.getAttribute("role") === "slider" || el?.isContentEditable) {
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
    setShowText(false);
    setWords([]);
  }, [fromMs, toMs, monitor, agentId]);

  // ── Selectable text overlay ─────────────────────────────────────────────────
  // Word boxes for the frame on screen. Fetched per frame rather than with the range
  // listing: 3000 frames' worth of word geometry would dwarf the metadata it rides
  // on. Skipped during playback — nobody selects text off a moving timelapse, and it
  // would fire a request per frame.
  useEffect(() => {
    setWords([]);
    if (!current || loading || playing || !current.has_ocr || !showText) {
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
  }, [agentId, current, loading, playing, showText]);

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

  const monitorId = String(monitor ?? monitors[0]?.monitor ?? 0);

  return (
    <div className="overflow-hidden rounded-xl bg-card">
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
          <Spinner className="size-8" aria-label="Loading screen history" />
        ) : blobUrl && failedUrl === blobUrl ? (
          <p className="px-4 text-center text-sm text-muted-foreground">This captured image could not be loaded.</p>
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
              key={blobUrl}
              ref={imgRef}
              src={blobUrl}
              alt={`Screen at ${current?.captured_at ?? ""}`}
              onLoad={(e) => { setReadyUrl(blobUrl); setImgHeight(e.currentTarget.clientHeight); }}
              onError={() => { setFailedUrl(blobUrl); setWords([]); }}
              style={{
                display: "block",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
            {showText && readyUrl === blobUrl && words.length > 0 && (
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
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {emptyMessage ?? "No screen history in this range yet."}
          </p>
        )}

        {/* Playhead clock, over the frame so it stays readable in fullscreen. */}
        {current && !loading && (
          <div
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              width: "fit-content",
              maxWidth: "calc(100% - 16px)",
              bottom: 12,
              padding: "4px 9px",
              borderRadius: 7,
              background: "rgba(0,0,0,0.62)",
              fontSize: 12,
              color: "#eceef1",
              pointerEvents: "none",
            }}
            className="font-mono tabular-nums"
          >
            <div>Captured {shortDateIn(timezone, times[index])} · {timeWithSecondsIn(timezone, times[index])}</div>
            <div>Playhead {timeWithSecondsIn(timezone, playheadMs)}
              {playheadMs - times[index] > MIN_HOLD_MS && ` · last capture ${formatDuration((playheadMs - times[index]) / 1000)} earlier`}
              {playheadMs < times[index] && " · first capture is later"}
            </div>
          </div>
        )}
      </div>

      {current && !loading && readyUrl === blobUrl && failedUrl !== blobUrl && <div className="recall-player-context"><RecallCaptureContext context={current.context}/></div>}

      {/* Transport */}
      <div className="recall-transport bg-muted/50 px-3.5 py-2.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
          <Button
            onClick={togglePlay}
            disabled={loading || frames.length === 0}
            aria-label={playing ? "Pause (space)" : "Play (space)"}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button variant="outline" onClick={() => step(-1)} disabled={loading || frames.length === 0} aria-label="Previous frame">
            ‹
          </Button>
          <Button variant="outline" onClick={() => step(1)} disabled={loading || frames.length === 0} aria-label="Next frame">
            ›
          </Button>
          <ToggleGroup
            size="sm"
            spacing={0}
            className="rounded-lg bg-muted/70 p-0.5"
            aria-label="Playback speed"
            value={[speedId]}
            onValueChange={(value) => {
              if (value[0]) setSpeedId(value[0]);
            }}
          >
            {SPEEDS.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id} aria-label={`${s.text} per second`} className="rounded-md! px-2.5 font-mono aria-pressed:bg-background">
                {s.text}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {monitors.length > 1 && (
            <ToggleGroup
              size="sm"
              spacing={0}
              className="max-w-full flex-wrap rounded-lg bg-muted/70 p-0.5"
              aria-label="Display"
              value={[monitorId]}
              onValueChange={(value) => {
                if (value[0] != null) onMonitorChange(Number(value[0]));
              }}
            >
              {monitors.map((m) => (
                <ToggleGroupItem key={m.monitor} value={String(m.monitor)} aria-label={`Display ${m.monitor + 1}`} className="rounded-md! px-2.5 aria-pressed:bg-background">
                  Display {m.monitor + 1}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            onClick={() => setShowText((v) => !v)}
            disabled={!current?.has_ocr}
            aria-label={showText ? "Hide selectable text (t)" : "Select text on this frame (t)"}
          >
            {showText ? "Done" : "Select text"}
          </Button>
          <Button variant="outline" onClick={toggleFullscreen} aria-label="Fullscreen (f)">
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
          disabled={loading || frames.length === 0}
        />

        <div className="mt-2.5">
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

        <div className="pt-2 text-[11px] text-muted-foreground">
          Space play/pause · ←/→ frame · J/L ±1 min · F fullscreen · T select text
        </div>
      </div>
    </div>
  );
}
