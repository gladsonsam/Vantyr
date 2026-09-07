import { useMemo } from "react";
import { api } from "../../lib/api";
import type { ScreenFrame } from "../../lib/types";
import { timeIn } from "./recallFormat";

/** Thumbnail width requested per cell (snaps to a server-side cache bucket). */
const CELL_W = 160;

/** Cells rendered. Enough to read the shape of the range; few enough to stay cheap. */
const CELLS = 18;

interface RecallFilmstripProps {
  agentId: string;
  frames: ScreenFrame[];
  playheadMs: number;
  onSeek: (ms: number) => void;
  timezone: string | null;
}

/**
 * A sampled strip of thumbnails across the loaded range.
 *
 * Deliberately an *overview* rather than the frames adjacent to the playhead: the
 * question this answers is "what happened across this window, and where should I
 * look?", which neighbouring frames — near-identical by construction, since capture
 * drops near-duplicates — cannot answer.
 *
 * Cells are sampled evenly in time, not by array index, so the strip stays aligned
 * with the scrubber above it. Each cell requests a downscale; at full keyframe size
 * this strip alone would pull several megabytes per range change.
 */
export function RecallFilmstrip({
  agentId,
  frames,
  playheadMs,
  onSeek,
  timezone,
}: RecallFilmstripProps) {
  const cells = useMemo(() => {
    if (frames.length === 0) return [];
    const times = frames.map((f) => new Date(f.captured_at).getTime());
    const first = times[0];
    const last = times[times.length - 1];
    const span = Math.max(1, last - first);
    const out: { frame: ScreenFrame; t: number }[] = [];
    let lastId = -1;
    for (let i = 0; i < CELLS; i++) {
      const target = first + (span * i) / Math.max(1, CELLS - 1);
      // Nearest frame at-or-after the sample point.
      let lo = 0;
      let hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      // A sparse range has fewer distinct frames than cells; skip repeats rather
      // than rendering the same screenshot several times in a row.
      if (frames[lo].id === lastId) continue;
      lastId = frames[lo].id;
      out.push({ frame: frames[lo], t: times[lo] });
    }
    return out;
  }, [frames]);

  if (cells.length === 0) return null;

  // Highlight the cell whose frame the playhead is currently nearest.
  let activeId = cells[0].frame.id;
  let best = Infinity;
  for (const c of cells) {
    const d = Math.abs(c.t - playheadMs);
    if (d < best) {
      best = d;
      activeId = c.frame.id;
    }
  }

  return (
    <div style={{ display: "flex", gap: 4, overflowX: "auto", padding: "2px 0" }}>
      {cells.map((c) => {
        const active = c.frame.id === activeId;
        return (
          <button
            key={c.frame.id}
            onClick={() => onSeek(c.t)}
            title={timeIn(timezone, c.frame.captured_at)}
            style={{
              flex: "0 0 auto",
              width: 104,
              padding: 0,
              border: `1px solid ${active ? "var(--gr)" : "var(--line)"}`,
              borderRadius: 7,
              overflow: "hidden",
              background: "var(--card)",
              cursor: "pointer",
              opacity: active ? 1 : 0.7,
              transition: "opacity 120ms ease, border-color 120ms ease",
            }}
          >
            <img
              src={api.historyBlobUrl(agentId, c.frame.id, CELL_W)}
              alt=""
              loading="lazy"
              style={{ display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "cover" }}
            />
            <span
              style={{
                display: "block",
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: active ? "var(--tx)" : "var(--tx-3)",
                padding: "3px 0",
              }}
            >
              {timeIn(timezone, c.frame.captured_at)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
