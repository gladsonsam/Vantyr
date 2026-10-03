import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { HistoryDay } from "../../lib/types";
import { todayIso } from "./recallFormat";

/** Weeks of coverage shown in the grid. */
const WEEKS = 12;

/** Add `days` to a `YYYY-MM-DD` string, staying in calendar days (no UTC drift). */
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

interface RecallDayPickerProps {
  agentId: string;
  /** Selected day, `YYYY-MM-DD` in the agent's zone. */
  day: string;
  onChange: (day: string) => void;
  timezone: string | null;
}

/**
 * Day selector with a coverage heatmap.
 *
 * The bare `<input type="date">` this replaces was blind: nothing said which days
 * held any recording, so finding a recorded day meant stepping through empties one
 * at a time and guessing when retention had cut off. Each cell is shaded by that
 * day's keyframe count, and days with no coverage aren't clickable.
 */
export function RecallDayPicker({ agentId, day, onChange, timezone }: RecallDayPickerProps) {
  const [days, setDays] = useState<HistoryDay[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .historyDays(agentId, {})
      .then((res) => alive && setDays(res.days))
      .catch(() => alive && setDays([]));
    return () => {
      alive = false;
    };
  }, [agentId]);

  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const maxCount = useMemo(() => days.reduce((m, d) => Math.max(m, d.frame_count), 1), [days]);

  /**
   * Columns of seven days ending on today (in the agent's zone), so the newest
   * column sits on the right and each row is a fixed weekday — the same reading
   * order as a contribution graph.
   */
  const columns = useMemo(() => {
    const today = todayIso(timezone ?? undefined);
    // Pad forward to the end of the current week so today lands in the last column
    // at its real weekday position rather than always in the bottom-right corner.
    const trailing = 6 - new Date(`${today}T00:00:00`).getDay();
    const last = addDays(today, trailing);
    const cells: string[] = [];
    for (let i = WEEKS * 7 - 1; i >= 0; i--) cells.push(addDays(last, -i));
    const cols: string[][] = [];
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));
    return { cols, today };
  }, [timezone]);

  const covered = useMemo(
    () => days.filter((d) => d.frame_count > 0).map((d) => d.day),
    [days],
  );

  /**
   * Cell geometry.
   *
   * Cells are `size` wide (border-box) with a 2px gap, so the centre-to-centre
   * pitch is `size + 2`. The hit area is grown by `gap / 2 = 1`px on each side,
   * which brings the target exactly up to the pitch — the largest it can be without
   * overlapping the neighbouring day and stealing its click.
   *
   * On touch the cells are 22px: with the 1px inset the target is 24px, and the whole grid is 12 × 22 + 11 × 2 = 286px — which still
   * fits a 320px viewport once the panel's own padding is accounted for. On a mouse
   * the compact 11px grid is kept, because there the heatmap's visual density
   * matters more than target size.
   */
  const CELL_GAP = 2;
  const TOUCH_SIZE = 22;
  const MOUSE_SIZE = 11;
  const HIT_INSET = CELL_GAP / 2;
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(pointer: coarse)");
    const sync = () => setTouch(mq?.matches === true);
    sync();
    mq?.addEventListener?.("change", sync);
    return () => mq?.removeEventListener?.("change", sync);
  }, []);

  const size = touch ? TOUCH_SIZE : MOUSE_SIZE;

  /** Step to the previous/next day that actually has coverage. */
  const stepCovered = (dir: -1 | 1) => {
    if (covered.length === 0) return;
    const sorted = covered.slice().sort();
    const next =
      dir === 1 ? sorted.find((d) => d > day) : sorted.slice().reverse().find((d) => d < day);
    if (next) onChange(next);
  };

  const hasPrev = covered.some((d) => d < day);
  const hasNext = covered.some((d) => d > day);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.09em",
            textTransform: "uppercase",
            color: "var(--tx-3)",
            marginBottom: 6,
          }}
        >
          Coverage
        </div>
        <div style={{ display: "flex", gap: CELL_GAP }}>
          {columns.cols.map((col, ci) => (
            <div key={ci} style={{ display: "flex", flexDirection: "column", gap: CELL_GAP }}>
              {col.map((d) => {
                const row = byDay.get(d);
                const future = d > columns.today;
                const selected = d === day;
                const ratio = row ? row.frame_count / maxCount : 0;
                return (
                  <button
                    key={d}
                    onClick={() => row && onChange(d)}
                    disabled={!row || future}
                    title={
                      future
                        ? d
                        : row
                          ? `${d} · ${row.frame_count} frames${row.has_summary ? " · summarized" : ""}`
                          : `${d} · nothing recorded`
                    }
                    aria-label={d}
                    aria-current={selected}
                    style={{
                      position: "relative",
                      width: size,
                      height: size,
                      padding: 0,
                      borderRadius: 2,
                      border: selected ? "1px solid var(--tx)" : "1px solid transparent",
                      background: row
                        ? `color-mix(in srgb, var(--gr) ${Math.round(22 + ratio * 78)}%, transparent)`
                        : "var(--line)",
                      opacity: future ? 0.25 : 1,
                      cursor: row && !future ? "pointer" : "default",
                    }}
                  >
                    {/* Expanded hit area, rendered inside the button so it hit-tests
                        as part of the control. Off on non-touch, where the cells are
                        already large enough. */}
                    {touch && row && !future && (
                      <span
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          inset: -HIT_INSET,
                          borderRadius: 4,
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => stepCovered(-1)}
          disabled={!hasPrev}
          aria-label="Previous recorded day"
          style={dayNavStyle(!hasPrev)}
        >
          ‹
        </button>
        <input
          type="date"
          value={day}
          // Cap at today *in the agent's zone* — an agent ahead of the viewer can
          // legitimately already be on tomorrow's date.
          max={todayIso(timezone ?? undefined)}
          onChange={(e) => onChange(e.target.value || todayIso(timezone ?? undefined))}
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
        <button
          onClick={() => stepCovered(1)}
          disabled={!hasNext}
          aria-label="Next recorded day"
          style={dayNavStyle(!hasNext)}
        >
          ›
        </button>
      </div>
    </div>
  );
}

function dayNavStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: 7,
    border: "1px solid var(--line)",
    background: "transparent",
    color: "var(--tx-2)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    lineHeight: 1,
  };
}
