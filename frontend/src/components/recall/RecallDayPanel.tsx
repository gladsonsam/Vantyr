import { Box, Spinner } from "../ui/console";
import type { RecallDayContext } from "./RecallView";
import { catColor, parseDayLocal, timeIn, todayIso } from "./recallFormat";

/**
 * The day panel: narrative, the shape of the day, and its sessions.
 *
 * Every row seeks the player, so reading "a stretch of Slack at 2pm" and seeing that
 * screen is one click.
 */
export function RecallDayPanel({
  day,
  onDayChange,
  summary,
  segments,
  timezone,
  loading,
  onSeek,
}: RecallDayContext) {
  return (
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
          {parseDayLocal(day).toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
          {timezone && (
            <span
              style={{
                marginLeft: 10,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                fontWeight: 400,
                color: "var(--tx-3)",
              }}
              title="Days are bucketed in the agent's timezone"
            >
              {timezone}
            </span>
          )}
        </span>
        <input
          type="date"
          value={day}
          // Cap at today *in the agent's zone* — an agent ahead of the viewer can
          // legitimately already be on tomorrow's date.
          max={todayIso(timezone ?? undefined)}
          onChange={(e) => onDayChange(e.target.value || todayIso(timezone ?? undefined))}
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

      {loading ? (
        <Spinner />
      ) : !summary?.narrative && segments.length === 0 ? (
        <Box color="text-body-secondary" fontSize="body-s">
          Nothing recorded for this day yet.
        </Box>
      ) : (
        <>
          {summary?.narrative && (
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
              {summary.narrative}
            </p>
          )}

          {/* Day ribbon — the shape of the day, colour only, no labels. */}
          {segments.length > 0 && (
            <div style={{ display: "flex", gap: 2, height: 8, marginBottom: 20 }}>
              {segments.map((seg) => {
                const dur = Math.max(
                  1,
                  new Date(seg.end_ts).getTime() - new Date(seg.start_ts).getTime(),
                );
                return (
                  <button
                    key={seg.id}
                    onClick={() => onSeek(seg.start_ts)}
                    title={timeIn(timezone, seg.start_ts)}
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

          {/* Sessions — click any to seek the replay there. */}
          {segments.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {segments.map((seg, i) => (
                <button
                  key={seg.id}
                  onClick={() => onSeek(seg.start_ts)}
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
                    {timeIn(timezone, seg.start_ts)}
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
  );
}
