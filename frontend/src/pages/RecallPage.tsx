import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  ContentLayout,
  Header,
  SegmentedControl,
  Select,
  SpaceBetween,
  Spinner,
} from "../components/ui/console";
import { api } from "../lib/api";
import type {
  Agent,
  ActivityPoint,
  ActivitySegment,
  DaySummary,
  OcrWord,
  ScreenFrame,
  ScreenFrameSearchResult,
} from "../lib/types";

/** Category → accent color for chips/bars. */
const CATEGORY_COLOR: Record<string, string> = {
  dev: "#20dd8f",
  terminal: "#5eead4",
  browsing: "#60a5fa",
  comms: "#c084fc",
  docs: "#fbbf24",
  design: "#f472b6",
  media: "#f87171",
  other: "#94a3b8",
};

function catColor(cat: string): string {
  return CATEGORY_COLOR[cat] ?? CATEGORY_COLOR.other;
}

/**
 * Today's calendar date in `tz` (or the viewer's own zone if unspecified), as
 * `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is the *UTC* date, so for
 * anyone east of UTC it names tomorrow late in the evening, and for anyone west it
 * names yesterday in the morning. `en-CA` formats as `YYYY-MM-DD`.
 */
function todayIso(tz?: string): string {
  return new Date().toLocaleDateString("en-CA", tz ? { timeZone: tz } : undefined);
}

/** Time-of-day in the agent's zone, so labels match the day they're filed under. */
function timeIn(tz: string | null, iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Render a ts_headline snippet, bolding the [[[…]]]-delimited matched terms (safe: no HTML). */
function renderSnippet(snippet: string): ReactNode[] {
  return snippet.split(/(\[\[\[.*?\]\]\])/g).map((part, i) => {
    const m = /^\[\[\[(.*?)\]\]\]$/.exec(part);
    return m ? (
      <strong key={i} style={{ color: "var(--gr)" }}>
        {m[1]}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    );
  });
}

type RangePreset = "6h" | "24h" | "7d";

const RANGE_MS: Record<RangePreset, number> = {
  "6h": 6 * 3600 * 1000,
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
};

/** Playback cadence options (frame advance interval, ms). */
const SPEEDS = [
  { id: "slow", text: "1×", ms: 700 },
  { id: "med", text: "2×", ms: 350 },
  { id: "fast", text: "4×", ms: 160 },
];

/**
 * Screen history / "Recall" — DVR playback of persisted screen keyframes.
 *
 * Phase 1 (DVR): agent picker + range + scrubber + timelapse playback over the
 * `screen_frames` index, streaming each keyframe's JPEG from the blob endpoint.
 * OCR search (Phase 2) and the AI day-narrative (Phase 3) build on this view.
 */
export function RecallPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [preset, setPreset] = useState<RangePreset>("24h");
  const [speedId, setSpeedId] = useState<string>("med");

  const [frames, setFrames] = useState<ScreenFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // The [from, to] window the loaded frames cover; search is scoped to the same window.
  const [loadedRange, setLoadedRange] = useState<{ from: string; to: string } | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScreenFrameSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Interactivity histogram (keyframe density per bucket) over the loaded range.
  const [activity, setActivity] = useState<{ points: ActivityPoint[]; bucketSecs: number } | null>(
    null,
  );

  const [summaryDay, setSummaryDay] = useState<string>(todayIso());
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [segments, setSegments] = useState<ActivitySegment[]>([]);
  // The agent's IANA zone, reported alongside the day. Day rows are bucketed in the
  // agent's local day, so times must be rendered in it too — otherwise an operator in
  // a different zone sees a session list that contradicts the date above it.
  const [dayTimezone, setDayTimezone] = useState<string | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);

  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingFrames, setLoadingFrames] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // OCR word boxes for the frame currently on screen.
  const [words, setWords] = useState<OcrWord[]>([]);
  const [showText, setShowText] = useState(false);
  // Rendered size of the <img>. Word boxes are normalized 0..1, so turning them into
  // a readable font size needs the actual pixel height the frame is drawn at.
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgHeight, setImgHeight] = useState(0);

  // ── Load the agent list once, filtered to agents that actually have recall history ──
  useEffect(() => {
    let alive = true;
    setLoadingAgents(true);
    Promise.all([api.agentsOverview(), api.historyDevices()])
      .then(([overviewRes, devicesRes]) => {
        if (!alive) return;
        const withHistory = new Set(devicesRes.agent_ids);
        const filtered = overviewRes.agents.filter((a) => withHistory.has(a.id));
        setAgents(filtered);
        // Prefer an online agent as the default selection.
        const first = filtered.find((a) => a.online) ?? filtered[0];
        setAgentId((cur) => cur ?? first?.id ?? null);
      })
      .catch(() => alive && setError("Failed to load agents."))
      .finally(() => alive && setLoadingAgents(false));
    return () => {
      alive = false;
    };
  }, []);

  // ── Load frames whenever the agent or range changes ──
  const loadFrames = useCallback(() => {
    if (!agentId) return;
    setLoadingFrames(true);
    setError(null);
    setPlaying(false);
    setResults(null);
    const to = new Date();
    const from = new Date(to.getTime() - RANGE_MS[preset]);
    setLoadedRange({ from: from.toISOString(), to: to.toISOString() });
    api
      .historyFrames(agentId, from.toISOString(), to.toISOString(), 3000)
      .then((res) => {
        setFrames(res.frames);
        setIndex(res.frames.length > 0 ? res.frames.length - 1 : 0);
      })
      .catch(() => setError("Failed to load screen history for this agent."))
      .finally(() => setLoadingFrames(false));
    api
      .historyActivity(agentId, from.toISOString(), to.toISOString(), 120)
      .then((res) => setActivity({ points: res.points, bucketSecs: res.bucket_secs }))
      .catch(() => setActivity(null));
  }, [agentId, preset]);

  /**
   * OCR search across **all** retained history, not just the loaded window.
   *
   * Scoping search to the visible range made "when did I last see X?" unanswerable
   * unless you had already guessed the right range. Hits outside the window are
   * handled by `jumpToTime`, which loads frames around the result first.
   */
  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!agentId || !q) return;
    setSearching(true);
    setError(null);
    // Far wider than any plausible retention setting; the server clamps results.
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 3600 * 1000);
    api
      .historySearch(agentId, q, from.toISOString(), to.toISOString(), 100)
      .then((res) => setResults(res.results))
      .catch(() => setError("Search failed."))
      .finally(() => setSearching(false));
  }, [agentId, query]);

  // Jump the scrubber to the loaded frame nearest a timestamp.
  //
  // `frames` is ordered by captured_at, so this binary-searches rather than scanning
  // — the range cap is 3000 frames and this runs on every ribbon/segment/result click.
  const jumpToFrame = useCallback(
    (target: string) => {
      if (frames.length === 0) return;
      const t = new Date(target).getTime();
      let lo = 0;
      let hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (new Date(frames[mid].captured_at).getTime() < t) lo = mid + 1;
        else hi = mid;
      }
      // `lo` is the first frame at-or-after t; the one before may be nearer.
      const prev = Math.max(0, lo - 1);
      const dLo = Math.abs(new Date(frames[lo].captured_at).getTime() - t);
      const dPrev = Math.abs(new Date(frames[prev].captured_at).getTime() - t);
      setPlaying(false);
      setIndex(dPrev <= dLo ? prev : lo);
    },
    [frames],
  );

  /**
   * Jump to a timestamp that may fall outside the loaded window.
   *
   * Search spans all retained history, so a hit can easily land days outside the
   * currently loaded range — where `jumpToFrame` would silently clamp to the nearest
   * loaded edge and show the wrong screen. Load a window around the target first,
   * then land on it.
   */
  const jumpToTime = useCallback(
    (target: string) => {
      if (!agentId) return;
      const t = new Date(target).getTime();
      const inRange =
        loadedRange !== null &&
        t >= new Date(loadedRange.from).getTime() &&
        t <= new Date(loadedRange.to).getTime();
      if (inRange) {
        jumpToFrame(target);
        return;
      }
      const from = new Date(t - 30 * 60 * 1000);
      const to = new Date(t + 30 * 60 * 1000);
      setLoadingFrames(true);
      setPlaying(false);
      setError(null);
      setLoadedRange({ from: from.toISOString(), to: to.toISOString() });
      api
        .historyFrames(agentId, from.toISOString(), to.toISOString(), 3000)
        .then((res) => {
          setFrames(res.frames);
          // Land on the nearest frame in the freshly loaded window.
          let best = 0;
          let bestDiff = Infinity;
          res.frames.forEach((f, i) => {
            const d = Math.abs(new Date(f.captured_at).getTime() - t);
            if (d < bestDiff) {
              bestDiff = d;
              best = i;
            }
          });
          setIndex(best);
        })
        .catch(() => setError("Failed to load screen history around that moment."))
        .finally(() => setLoadingFrames(false));
      api
        .historyActivity(agentId, from.toISOString(), to.toISOString(), 120)
        .then((res) => setActivity({ points: res.points, bucketSecs: res.bucket_secs }))
        .catch(() => setActivity(null));
    },
    [agentId, loadedRange, jumpToFrame],
  );

  // Dense buckets across the loaded range (0-filled gaps) for the activity strip.
  const activityBars = useMemo(() => {
    if (!activity || !loadedRange || !activity.bucketSecs) return [];
    const bs = activity.bucketSecs;
    const fromS = Math.floor(new Date(loadedRange.from).getTime() / 1000);
    const toS = Math.ceil(new Date(loadedRange.to).getTime() / 1000);
    const start = Math.floor(fromS / bs) * bs;
    const counts = new Map(activity.points.map((p) => [p.t, p.count]));
    const bars: { t: number; count: number }[] = [];
    for (let t = start; t < toS && bars.length < 600; t += bs) {
      bars.push({ t, count: counts.get(t) ?? 0 });
    }
    return bars;
  }, [activity, loadedRange]);
  const activityMax = useMemo(
    () => activityBars.reduce((m, b) => Math.max(m, b.count), 1),
    [activityBars],
  );

  useEffect(() => {
    loadFrames();
  }, [loadFrames]);

  // ── Load the day narrative + segments whenever the agent or day changes ──
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
        setDayTimezone(null);
      })
      .finally(() => alive && setLoadingDay(false));
    return () => {
      alive = false;
    };
  }, [agentId, summaryDay]);

  // ── Timelapse playback ──
  const speedMs = useMemo(
    () => SPEEDS.find((s) => s.id === speedId)?.ms ?? 350,
    [speedId],
  );
  const framesLen = frames.length;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!playing || framesLen === 0) return;
    timer.current = setInterval(() => {
      setIndex((i) => {
        if (i + 1 >= framesLen) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, speedMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, framesLen, speedMs]);

  const current: ScreenFrame | undefined = frames[index];
  const blobUrl = useMemo(
    () => (agentId && current ? api.historyBlobUrl(agentId, current.id) : null),
    [agentId, current],
  );

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

  // ── Selectable text overlay ──
  // Word boxes for the frame on screen. Fetched per frame rather than with the range
  // listing: 3000 frames' worth of word geometry would dwarf the metadata it rides on.
  // Skipped during playback — nobody selects text off a moving timelapse, and it would
  // fire a request per frame.
  useEffect(() => {
    if (!agentId || !current || playing || !current.has_ocr) {
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
  }, [agentId, current, playing]);

  // ── Decode-ahead ──
  // Each frame is a separate HTTP fetch, so at 4× (one frame every 160ms) playback
  // outruns the network and stutters. Warm the browser cache for the frames just
  // ahead of the playhead; the blob endpoint sends a long private max-age, so by
  // the time the <img> src flips the bytes are already local.
  const prefetched = useRef<Set<number>>(new Set());
  useEffect(() => {
    // Reloading the range invalidates which ids are worth holding.
    prefetched.current = new Set();
  }, [loadedRange, agentId]);
  useEffect(() => {
    if (!agentId || frames.length === 0) return;
    // Prefetch further ahead when playing fast, since there's less time per frame.
    const ahead = playing ? Math.max(8, Math.round(4000 / speedMs)) : 3;
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
  }, [agentId, frames, index, playing, speedMs]);

  const agentOptions = useMemo(
    () =>
      agents.map((a) => ({
        value: a.id,
        label: a.name,
        labelTag: a.online ? "online" : "offline",
      })),
    [agents],
  );
  const selectedOption = useMemo(
    () => agentOptions.find((o) => o.value === agentId) ?? null,
    [agentOptions, agentId],
  );

  const togglePlay = () => {
    if (framesLen === 0) return;
    // Restart from the beginning if paused at the very end.
    if (!playing && index >= framesLen - 1) setIndex(0);
    setPlaying((p) => !p);
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Scrub and replay persisted screen keyframes captured on meaningful change (window/URL focus + active heartbeat). Frames are strategic, not fixed-fps — gaps mean the machine was idle or unchanged."
          actions={
            <Button
              iconName="refresh"
              onClick={loadFrames}
              disabled={!agentId || loadingFrames}
            >
              Reload
            </Button>
          }
        >
          Recall
        </Header>
      }
    >
      <div className="vantyr-admin-page sx-console">
        <SpaceBetween size="l">
          {/* Controls */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "flex-end",
            }}
          >
            <div style={{ minWidth: 240 }}>
              <Box
                fontSize="body-s"
                color="text-body-secondary"
                margin={{ bottom: "xxs" }}
              >
                Agent
              </Box>
              <Select
                selectedOption={selectedOption}
                onChange={({ detail }) =>
                  setAgentId(detail.selectedOption?.value ?? null)
                }
                options={agentOptions}
                placeholder={loadingAgents ? "Loading agents…" : "Select an agent"}
                disabled={loadingAgents || agents.length === 0}
                empty="No agents"
              />
            </div>
            <div>
              <Box
                fontSize="body-s"
                color="text-body-secondary"
                margin={{ bottom: "xxs" }}
              >
                Range
              </Box>
              <SegmentedControl
                selectedId={preset}
                onChange={({ detail }) =>
                  setPreset(detail.selectedId as RangePreset)
                }
                options={[
                  { id: "6h", text: "Last 6h" },
                  { id: "24h", text: "Last 24h" },
                  { id: "7d", text: "Last 7d" },
                ]}
              />
            </div>
            <div>
              <Box
                fontSize="body-s"
                color="text-body-secondary"
                margin={{ bottom: "xxs" }}
              >
                Speed
              </Box>
              <SegmentedControl
                selectedId={speedId}
                onChange={({ detail }) => setSpeedId(detail.selectedId)}
                options={SPEEDS.map((s) => ({ id: s.id, text: s.text }))}
              />
            </div>
          </div>

          {/* OCR search */}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
              placeholder="Search all screen text (OCR)…"
              disabled={!agentId}
              style={{
                flex: 1,
                maxWidth: 460,
                padding: "9px 12px",
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: "var(--card)",
                color: "var(--tx)",
                fontFamily: "var(--font)",
                fontSize: 13.5,
              }}
            />
            <Button
              onClick={runSearch}
              loading={searching}
              disabled={!agentId || query.trim() === ""}
            >
              Search
            </Button>
            {results !== null && (
              <Button
                variant="link"
                onClick={() => {
                  setResults(null);
                  setQuery("");
                }}
              >
                Clear
              </Button>
            )}
          </div>

          {results !== null && (
            <div
              style={{
                background: "var(--card)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                maxHeight: 260,
                overflowY: "auto",
              }}
            >
              {results.length === 0 ? (
                <Box padding={{ vertical: "m", horizontal: "l" }} color="text-body-secondary">
                  No matches in this range.
                </Box>
              ) : (
                results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => jumpToTime(r.captured_at)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 16px",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--line)",
                      color: "var(--tx)",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11.5,
                        color: "var(--tx-2)",
                      }}
                    >
                      {new Date(r.captured_at).toLocaleString()}
                    </span>
                    <span style={{ fontSize: 13 }}>{renderSnippet(r.snippet)}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {error && (
            <Box color="text-status-error" fontSize="body-s">
              {error}
            </Box>
          )}

          {/* Viewer */}
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            <div
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
              {loadingFrames ? (
                <Spinner size="large" />
              ) : blobUrl ? (
                // The wrapper shrink-wraps the letterboxed image so the word overlay
                // shares its exact box — percentage coordinates then line up with the
                // pixels regardless of how the 16:9 stage letterboxes the frame.
                <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", maxHeight: "100%" }}>
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
                      style={{
                        position: "absolute",
                        inset: 0,
                        cursor: "text",
                        userSelect: "text",
                      }}
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
                <Box
                  textAlign="center"
                  color="text-body-secondary"
                  padding={{ vertical: "xxl" }}
                >
                  {agents.length === 0
                    ? "No agents available."
                    : "No screen history in this range yet."}
                </Box>
              )}
            </div>

            {/* Transport */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 16px",
                borderTop: "1px solid var(--line)",
              }}
            >
              <Button
                variant="primary"
                onClick={togglePlay}
                disabled={framesLen === 0}
                ariaLabel={playing ? "Pause" : "Play"}
              >
                {playing ? "Pause" : "Play"}
              </Button>
              <Button
                onClick={() => setShowText((v) => !v)}
                disabled={!current?.has_ocr}
                ariaLabel={showText ? "Hide selectable text" : "Select text on this frame"}
              >
                {showText ? "Done" : "Select text"}
              </Button>
              <input
                type="range"
                min={0}
                max={Math.max(0, framesLen - 1)}
                value={index}
                onChange={(e) => {
                  setPlaying(false);
                  setIndex(Number(e.target.value));
                }}
                disabled={framesLen === 0}
                style={{ flex: 1, accentColor: "var(--gr)", cursor: "pointer" }}
              />
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12.5,
                  color: "var(--tx-2)",
                  whiteSpace: "nowrap",
                  minWidth: 190,
                  textAlign: "right",
                }}
              >
                {current ? (
                  <>
                    {new Date(current.captured_at).toLocaleString()}
                    {current.has_ocr && (
                      <span
                        title="This frame has OCR text and is searchable"
                        style={{ color: "var(--gr)", marginLeft: 8 }}
                      >
                        ●
                      </span>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </div>
            </div>
          </div>

          {/* Interactivity — keyframe density is a proxy for how actively the
              machine was used (capture speeds up during active use). Click to jump. */}
          {activityBars.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: "0.09em",
                  textTransform: "uppercase",
                  color: "var(--tx-3)",
                  marginBottom: 7,
                }}
              >
                Activity
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 44 }}>
                {activityBars.map((b) => {
                  const ratio = b.count / activityMax;
                  const h = b.count === 0 ? 2 : 5 + ratio * 39;
                  const op = b.count === 0 ? 0.1 : 0.3 + ratio * 0.7;
                  return (
                    <button
                      key={b.t}
                      onClick={() => jumpToFrame(new Date(b.t * 1000).toISOString())}
                      title={new Date(b.t * 1000).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: "100%",
                        display: "flex",
                        alignItems: "flex-end",
                        padding: 0,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: "100%",
                          height: h,
                          background: "var(--gr)",
                          opacity: op,
                          borderRadius: 2,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Day ── */}
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 14,
              padding: "20px 22px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 18,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--display)",
                  fontSize: 17,
                  fontWeight: 600,
                  color: "var(--tx)",
                }}
              >
                {/* Parsed as local midnight (no trailing Z) so the weekday matches
                    the date string itself rather than shifting by the UTC offset. */}
                {new Date(`${summaryDay}T00:00:00`).toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
                {dayTimezone && (
                  <span
                    style={{
                      marginLeft: 10,
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      fontWeight: 400,
                      color: "var(--tx-3)",
                    }}
                    title="Days are bucketed in the agent's local timezone"
                  >
                    {dayTimezone}
                  </span>
                )}
              </span>
              <input
                type="date"
                value={summaryDay}
                // Cap at today *in the agent's zone* — an agent ahead of the viewer
                // can legitimately already be on tomorrow's date.
                max={todayIso(dayTimezone ?? undefined)}
                onChange={(e) =>
                  setSummaryDay(e.target.value || todayIso(dayTimezone ?? undefined))
                }
                style={{
                  padding: "5px 8px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  background: "transparent",
                  color: "var(--tx-2)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                }}
              />
            </div>

            {loadingDay ? (
              <Spinner />
            ) : !daySummary?.narrative && segments.length === 0 ? (
              <Box color="text-body-secondary" fontSize="body-s">
                Nothing recorded for this day yet.
              </Box>
            ) : (
              <>
                {daySummary?.narrative && (
                  <p
                    style={{
                      margin: "0 0 22px",
                      fontFamily: "var(--display)",
                      fontSize: 16,
                      lineHeight: 1.7,
                      color: "var(--tx)",
                      maxWidth: 760,
                    }}
                  >
                    {daySummary.narrative}
                  </p>
                )}

                {/* Day ribbon — the shape of the day, colour only, no labels. */}
                {segments.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      gap: 2,
                      height: 8,
                      marginBottom: 20,
                    }}
                  >
                    {segments.map((seg) => {
                      const dur = Math.max(
                        1,
                        new Date(seg.end_ts).getTime() - new Date(seg.start_ts).getTime(),
                      );
                      return (
                        <button
                          key={seg.id}
                          onClick={() => jumpToFrame(seg.start_ts)}
                          title={timeIn(dayTimezone, seg.start_ts)}
                          style={{
                            flex: dur,
                            minWidth: 3,
                            height: "100%",
                            padding: 0,
                            border: "none",
                            borderRadius: 3,
                            background: catColor(seg.category),
                            opacity: 0.85,
                            cursor: "pointer",
                          }}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Sessions — click any to jump the replay there. */}
                {segments.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {segments.map((seg, i) => (
                      <button
                        key={seg.id}
                        onClick={() => jumpToFrame(seg.start_ts)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          width: "100%",
                          textAlign: "left",
                          padding: "11px 4px",
                          background: "transparent",
                          border: "none",
                          borderTop: i === 0 ? "none" : "1px solid var(--line)",
                          color: "var(--tx)",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: catColor(seg.category),
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 12,
                            color: "var(--tx-3)",
                            whiteSpace: "nowrap",
                            minWidth: 62,
                          }}
                        >
                          {timeIn(dayTimezone, seg.start_ts)}
                        </span>
                        <span
                          style={{
                            fontSize: 13.5,
                            color: "var(--tx)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                        >
                          {seg.summary ?? seg.app ?? seg.title ?? ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </SpaceBetween>
      </div>
    </ContentLayout>
  );
}
