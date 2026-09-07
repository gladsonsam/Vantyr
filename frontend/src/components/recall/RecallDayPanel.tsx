import { useMemo } from "react";
import { Badge, Box, Spinner } from "../ui/console";
import { RecallDayPicker } from "./RecallDayPicker";
import type { RecallDayContext } from "./RecallView";
import { catColor, catLabel, formatDuration, parseDayLocal, timeIn } from "./recallFormat";

/** Segments shorter than this are dropped from the session list as alt-tab noise. */
const MIN_SESSION_MS = 60 * 1000;

function durationMs(startTs: string, endTs: string): number {
  return Math.max(0, new Date(endTs).getTime() - new Date(startTs).getTime());
}

/**
 * The day panel: what happened, in what proportion, and where to look.
 *
 * The narrative worker has always computed `totals`, `top_apps` and `highlights`
 * (they're in the day-summary response and were typed on the client), and the panel
 * rendered none of it — one paragraph, an 8px ribbon and a flat session list. That
 * was most of why the page read as thin: the interesting half of the data the server
 * derived never reached the screen.
 *
 * Everything here seeks the player, so reading "a stretch of Slack at 2pm" and
 * seeing that screen is one click.
 */
export function RecallDayPanel({
  agentId,
  day,
  onDayChange,
  summary,
  segments,
  timezone,
  loading,
  onSeek,
}: RecallDayContext) {
  const totals = summary?.totals;
  const byCategory = useMemo(() => {
    const entries = Object.entries(totals?.by_category ?? {});
    const total = entries.reduce((sum, [, secs]) => sum + secs, 0);
    return {
      total,
      rows: entries.sort((a, b) => b[1] - a[1]).map(([cat, secs]) => ({ cat, secs })),
    };
  }, [totals]);

  const topApps = summary?.top_apps ?? [];
  const appMax = topApps.reduce((m, a) => Math.max(m, a.seconds), 1);
  const highlights = summary?.highlights ?? [];

  // Alt-tabs and momentary focus changes make the list unreadable; the ribbon above
  // still shows them, since there the width carries the "this was brief" signal.
  const sessions = useMemo(
    () => segments.filter((s) => durationMs(s.start_ts, s.end_ts) >= MIN_SESSION_MS),
    [segments],
  );

  const empty = !summary?.narrative && segments.length === 0;

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
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <div>
          <div
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
          </div>
          {/* Where the narrative came from. A rule-based summary and a vision-model
              one read alike but are worth very different amounts of trust. */}
          {summary?.narrative && (
            <div style={{ marginTop: 7 }}>
              <Badge color={summary.source === "ai" ? "blue" : "grey"}>
                {summary.source === "ai" ? "AI narrative" : "Rule-based"}
              </Badge>
            </div>
          )}
        </div>
        <RecallDayPicker
          agentId={agentId}
          day={day}
          onChange={onDayChange}
          timezone={timezone}
        />
      </div>

      {loading ? (
        <Spinner />
      ) : empty ? (
        <Box color="text-body-secondary" fontSize="body-s">
          Nothing recorded for this day yet.
        </Box>
      ) : (
        <>
          {summary?.narrative && (
            <p
              style={{
                margin: "0 0 20px",
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

          {/* Headline numbers */}
          {(totals?.active_seconds || byCategory.rows.length > 0) && (
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 18 }}>
              <Stat label="Active" value={formatDuration(totals?.active_seconds ?? 0)} />
              {byCategory.rows[0] && (
                <Stat
                  label="Most time in"
                  value={catLabel(byCategory.rows[0].cat)}
                  accent={catColor(byCategory.rows[0].cat)}
                />
              )}
              <Stat label="Sessions" value={String(totals?.segment_count ?? segments.length)} />
            </div>
          )}

          {/* Category split — proportion of the day, as one bar plus a legend. */}
          {byCategory.total > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden" }}>
                {byCategory.rows.map((r) => (
                  <span
                    key={r.cat}
                    title={`${catLabel(r.cat)} · ${formatDuration(r.secs)}`}
                    style={{
                      flex: Math.max(1, r.secs),
                      background: catColor(r.cat),
                      opacity: 0.9,
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  flexWrap: "wrap",
                  paddingTop: 9,
                  fontSize: 12,
                  color: "var(--tx-2)",
                }}
              >
                {byCategory.rows.map((r) => (
                  <span key={r.cat} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: catColor(r.cat),
                      }}
                    />
                    {catLabel(r.cat)}
                    <span style={{ fontFamily: "var(--mono)", color: "var(--tx-3)" }}>
                      {formatDuration(r.secs)}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Highlights — the day's longest stretches, as jump targets. */}
          {highlights.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <SectionLabel>Highlights</SectionLabel>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {highlights.map((h) => (
                  <button
                    key={`${h.start_ts}-${h.label}`}
                    onClick={() => onSeek(h.start_ts)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 11px",
                      borderRadius: 999,
                      border: "1px solid var(--line)",
                      background: "transparent",
                      color: "var(--tx)",
                      fontSize: 12.5,
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: catColor(h.category),
                      }}
                    />
                    {h.label}
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--tx-3)" }}>
                      {timeIn(timezone, h.start_ts)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Top apps */}
          {topApps.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <SectionLabel>Top apps</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {topApps.map((a) => (
                  <div key={a.app} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      style={{
                        fontSize: 12.5,
                        color: "var(--tx)",
                        minWidth: 148,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.app}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        height: 6,
                        borderRadius: 3,
                        background: "var(--line)",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          width: `${(a.seconds / appMax) * 100}%`,
                          height: "100%",
                          background: "var(--gr)",
                          opacity: 0.8,
                        }}
                      />
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11.5,
                        color: "var(--tx-3)",
                        minWidth: 52,
                        textAlign: "right",
                      }}
                    >
                      {formatDuration(a.seconds)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Day ribbon — the shape of the day. Focused stretches read solid;
              distracting ones are faded, so the texture of the day is visible. */}
          {segments.length > 0 && (
            <>
              <SectionLabel>The day</SectionLabel>
              <div style={{ display: "flex", gap: 2, height: 10, marginBottom: 18 }}>
                {segments.map((seg) => (
                  <button
                    key={seg.id}
                    onClick={() => onSeek(seg.start_ts)}
                    title={`${timeIn(timezone, seg.start_ts)} · ${catLabel(seg.category)} · ${formatDuration(
                      durationMs(seg.start_ts, seg.end_ts) / 1000,
                    )}`}
                    style={{
                      flex: Math.max(1, durationMs(seg.start_ts, seg.end_ts)),
                      minWidth: 3,
                      height: "100%",
                      padding: 0,
                      border: "none",
                      borderRadius: 3,
                      background: catColor(seg.category),
                      opacity: 1 - seg.distraction_score * 0.6,
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {/* Sessions */}
          {sessions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {sessions.map((seg, i) => (
                <button
                  key={seg.id}
                  onClick={() => onSeek(seg.start_ts)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 4px",
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
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      color: "var(--tx-3)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatDuration(durationMs(seg.start_ts, seg.end_ts) / 1000)}
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

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: "var(--tx-3)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--display)",
          fontSize: 20,
          fontWeight: 600,
          color: accent ?? "var(--tx)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: "var(--tx-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
