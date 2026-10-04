import { useEffect, useId, useMemo, useState } from "react";
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
 * Redesign: the old panel stacked six same-weight sections in one flat card —
 * 10px labels, 7px dots, 6px bars on a low-contrast track, pill highlights with
 * full duplicated titles, and a session list that repeated the same
 * "app — title" string row after row. Nothing had hierarchy, proportions were
 * relative to the max (so everything looked "almost full"), and there was no
 * way to filter or skim.
 *
 * Now: a header card with the narrative, KPI cards, a two-column
 * breakdown (categories + apps, both as shares of active time), highlight
 * cards, a thicker timeline with an axis + legend, and a filterable session
 * list with time ranges, duration chips and a visible replay affordance.
 * Everything seeks the player.
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
  coverageScope,
  dayError,
}: RecallDayContext) {
  const segmentChooserId = useId();
  const totals = summary?.totals;
  const [appFilter, setAppFilter] = useState<string>("all");
  useEffect(() => { setAppFilter("all"); }, [agentId, day]);

  const byCategory = useMemo(() => {
    const entries = Object.entries(totals?.by_category ?? {});
    const total = entries.reduce((sum, [, secs]) => sum + secs, 0);
    return {
      total,
      rows: entries
        .sort((a, b) => b[1] - a[1])
        .map(([cat, secs]) => ({
          cat,
          secs,
          pct: total > 0 ? (secs / total) * 100 : 0,
        })),
    };
  }, [totals]);

  const activeSecs = totals?.active_seconds ?? byCategory.total;

  const topApps = useMemo(() => {
    const rows = (summary?.top_apps ?? []).slice().sort((a, b) => b.seconds - a.seconds);
    return rows.map((a) => ({
      ...a,
      pct: activeSecs > 0 ? (a.seconds / activeSecs) * 100 : 0,
    }));
  }, [summary, activeSecs]);

  const highlights = summary?.highlights ?? [];
  // The accessible chooser includes brief activity that the session list omits.
  const sourceSegments = useMemo(() => segments.filter(s =>
    Number.isFinite(Date.parse(s.start_ts)) && Number.isFinite(Date.parse(s.end_ts)) &&
    Date.parse(s.end_ts) > Date.parse(s.start_ts),
  ).slice().sort((a, b) => Date.parse(a.start_ts) - Date.parse(b.start_ts)), [segments]);

  // Alt-tabs and momentary focus changes make the list unreadable; the ribbon
  // above still shows them, since there the width carries the "this was brief"
  // signal.
  const sessions = useMemo(
    () =>
      segments
        .filter((s) => durationMs(s.start_ts, s.end_ts) >= MIN_SESSION_MS)
        .slice()
        .sort((a, b) => +new Date(a.start_ts) - +new Date(b.start_ts)),
    [segments],
  );

  // Weighted focus score from the segments themselves — no new API needed.
  const focusPct = useMemo(() => {
    let dur = 0;
    let distracted = 0;
    for (const s of sessions) {
      const d = durationMs(s.start_ts, s.end_ts);
      dur += d;
      distracted += d * (s.distraction_score ?? 0);
    }
    if (dur === 0) return null;
    return Math.round((1 - distracted / dur) * 100);
  }, [sessions]);

  const appOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      const app = s.app ?? "unknown";
      map.set(app, (map.get(app) ?? 0) + durationMs(s.start_ts, s.end_ts));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([app]) => app);
  }, [sessions]);

  // Reset the filter when the day's apps change out from under it.
  const filterValue = appOptions.includes(appFilter) ? appFilter : "all";

  const visibleSessions = useMemo(
    () =>
      filterValue === "all"
        ? sessions
        : sessions.filter((s) => (s.app ?? "unknown") === filterValue),
    [sessions, filterValue],
  );

  const legendCats = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of segments) seen.set(s.category, (seen.get(s.category) ?? 0) + 1);
    return [...seen.keys()].slice(0, 6);
  }, [segments]);

  const empty = !summary?.narrative && segments.length === 0;
  const dayLabel = parseDayLocal(day).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Header + narrative ─────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 280px" }}>
            <div
              style={{
                fontFamily: "var(--display)",
                fontSize: 19,
                fontWeight: 650,
                color: "var(--tx)",
                letterSpacing: "-0.01em",
              }}
            >
              {dayLabel}
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
            {summary?.narrative && (
              <div style={{ marginTop: 8 }}>
                <Badge color={summary.source === "ai" ? "blue" : "grey"}>
                  {summary.source === "ai" ? "AI-derived inference" : summary.source === "rule" ? "Rule-derived inference" : "Derived narrative"}
                </Badge>
              </div>
            )}
            {summary?.narrative && (
              <p
                style={{
                  margin: "12px 0 0",
                  fontSize: 14.5,
                  lineHeight: 1.65,
                  color: "var(--tx-2)",
                  maxWidth: 720,
                }}
              >
                {summary.narrative}
              </p>
            )}
          </div>
          {summary?.narrative && <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--tx-3)", overflowWrap: "anywhere" }}>
            This narrative is inferred from activity, not a recording. Highlights and sessions below open playback at their source times; a retained frame may be nearby rather than exactly at that time. Individual claims have no frame citations.
          </p>}
          <div className="recall-day-selection" style={{ flex: "0 1 480px", minWidth: 0, maxWidth: "100%", width: "100%" }}>
            <RecallDayPicker
              agentId={agentId}
              day={day}
              onChange={(d) => {
                setAppFilter("all");
                onDayChange(d);
              }}
              timezone={timezone}
              coverageScope={coverageScope}
              onSeek={onSeek}
            />
          </div>
        </div>

        {loading ? (
          <div style={{ paddingTop: 16 }}>
            <Spinner />
          </div>
        ) : (
          !empty && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
                gap: 10,
                marginTop: 18,
              }}
            >
              <Kpi label="Estimated active time" value={formatDuration(activeSecs)} sub={`${sessions.length} sessions`} />
              <Kpi
                label="Sessions"
                value={String(totals?.segment_count ?? segments.length)}
                sub={filterValue !== "all" ? `filtered: ${filterValue}` : "derived activity stretches"}
              />
              {byCategory.rows[0] ? (
                <Kpi
                  label="Top category"
                  value={catLabel(byCategory.rows[0].cat)}
                  sub={`${formatDuration(byCategory.rows[0].secs)} · ${Math.round(byCategory.rows[0].pct)}%`}
                  accent={catColor(byCategory.rows[0].cat)}
                />
              ) : (
                <Kpi label="Top category" value="—" sub="no data" />
              )}
              <Kpi
                label="Focus"
                value={focusPct == null ? "—" : `${focusPct}%`}
                sub={focusPct == null ? "no sessions" : "inferred from activity scores"}
                accent={focusPct != null && focusPct < 60 ? "var(--afk, #fbbf24)" : "var(--gr)"}
              />
            </div>
          )
        )}
      </section>

      {loading ? null : empty ? (
        <section style={cardStyle}>
          <Box color="text-body-secondary" fontSize="body-s">
            {dayError ? "Could not load the day summary and activity. Recording coverage is shown separately; choose another date or reload to retry." : "No derived summary or activity for this day. Check retained recording coverage above."}
          </Box>
        </section>
      ) : (
        <>
          {/* ── Breakdown ──────────────────────────────────────────────── */}
          {(byCategory.rows.length > 0 || topApps.length > 0) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
                gap: 14,
              }}
            >
              {byCategory.rows.length > 0 && (
                <section style={cardStyle}>
                  <CardTitle
                    title="Where the time went"
                    sub={`${formatDuration(byCategory.total)} active`}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
                    {byCategory.rows.map((r) => (
                      <div key={r.cat}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 6,
                          }}
                        >
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 13.5,
                              fontWeight: 600,
                              color: "var(--tx)",
                            }}
                          >
                            <span
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: 3,
                                background: catColor(r.cat),
                                flexShrink: 0,
                              }}
                            />
                            {catLabel(r.cat)}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 12,
                              color: "var(--tx-2)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {formatDuration(r.secs)} · {Math.round(r.pct)}%
                          </span>
                        </div>
                        <div style={trackStyle}>
                          <span style={{ ...fillStyle, width: `${r.pct}%`, background: catColor(r.cat) }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {topApps.length > 0 && (
                <section style={cardStyle}>
                  <CardTitle title="Top apps" sub="share of active time" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
                    {topApps.map((a) => (
                      <div key={a.app}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 6,
                          }}
                        >
                          <span
                            title={a.app}
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 12.5,
                              color: "var(--tx)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              maxWidth: "60%",
                            }}
                          >
                            {a.app}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 12,
                              color: "var(--tx-2)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {formatDuration(a.seconds)} · {Math.round(a.pct)}%
                          </span>
                        </div>
                        <div style={trackStyle} title={`${a.app} · ${formatDuration(a.seconds)} (${Math.round(a.pct)}% of active)`}>
                          <span style={{ ...fillStyle, width: `${Math.max(2, a.pct)}%`, background: "var(--gr)" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ── Highlights ─────────────────────────────────────────────── */}
          {highlights.length > 0 && (
            <section style={cardStyle}>
              <CardTitle title="Highlights" sub="derived activity — open source time" />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))",
                  gap: 10,
                  marginTop: 14,
                }}
              >
                {highlights.slice(0, 6).map((h) => {
                  const secs = durationMs(h.start_ts, h.end_ts) / 1000;
                  return (
                    <button
                      key={`${h.start_ts}-${h.label}`}
                      onClick={() => onSeek(h.start_ts)}
                      title={`Replay from ${timeIn(timezone, h.start_ts)}`}
                      style={highlightStyle(catColor(h.category))}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--line-3, #3a3f4a)")}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 11.5,
                            color: "var(--tx-2)",
                            background: "var(--card-3, rgba(255,255,255,0.06))",
                            borderRadius: 6,
                            padding: "2px 8px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {timeIn(timezone, h.start_ts)}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 11.5,
                            color: "var(--tx-3)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatDuration(secs)}
                        </span>
                      </span>
                      <span
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          fontSize: 13,
                          lineHeight: 1.5,
                          color: "var(--tx)",
                          textAlign: "left",
                        }}
                      >
                        {h.label}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--tx-3)", textAlign: "left" }}>
                        {catLabel(h.category)} · Open source time →
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Day timeline ───────────────────────────────────────────── */}
          {sourceSegments.length > 0 && (
            <section style={cardStyle}>
              <CardTitle
                title="Day timeline"
                sub={`${sourceSegments.length} activity segments · choose any source time below`}
              />
              <label htmlFor={segmentChooserId} style={{ display: "grid", gap: 6, marginTop: 14, minWidth: 0, fontSize: 12, color: "var(--tx-2)" }}>
                Open segment source time
                <select id={segmentChooserId} value="" onChange={event => {
                  const segment = sourceSegments.find(s => String(s.id) === event.target.value);
                  if (segment) onSeek(segment.start_ts);
                }} style={{ width: "100%", maxWidth: "100%", minWidth: 0, minHeight: 44, boxSizing: "border-box", padding: "8px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--tx-2)", fontSize: 16 }}>
                  <option value="">Choose an activity segment</option>
                  {sourceSegments.map(seg => <option key={seg.id} value={String(seg.id)}>
                    {timeIn(timezone, seg.start_ts)} · {formatDuration(durationMs(seg.start_ts, seg.end_ts) / 1000)} · {seg.title || seg.summary || seg.app || catLabel(seg.category)}
                  </option>)}
                </select>
              </label>
              <div
                data-proportional-timeline="true"
                role="img"
                aria-label="Activity segment durations; use Open segment source time to navigate"
                style={{ display: "flex", gap: 3, height: 20, marginTop: 14 }}
              >
                {sourceSegments.map((seg) => (
                  <span
                    key={seg.id}
                    aria-hidden="true"
                    title={`${timeIn(timezone, seg.start_ts)} → ${timeIn(timezone, seg.end_ts)} · ${catLabel(seg.category)} · ${formatDuration(durationMs(seg.start_ts, seg.end_ts) / 1000)}`}
                    style={{ flex: durationMs(seg.start_ts, seg.end_ts), minWidth: 0, height: "100%", borderRadius: 4, background: catColor(seg.category), opacity: 1 - seg.distraction_score * 0.55 }}
                  />
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  marginTop: 6,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--tx-3)",
                }}
              >
                <span>{timeIn(timezone, sourceSegments[0].start_ts)}</span>
                <span>{timeIn(timezone, sourceSegments[sourceSegments.length - 1].end_ts)}</span>
              </div>
              {legendCats.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 14,
                    flexWrap: "wrap",
                    marginTop: 10,
                    fontSize: 12,
                    color: "var(--tx-2)",
                  }}
                >
                  {legendCats.map((c) => (
                    <span key={c} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{ width: 9, height: 9, borderRadius: 3, background: catColor(c) }}
                      />
                      {catLabel(c)}
                    </span>
                  ))}
                  <span style={{ color: "var(--tx-3)" }}>faded = distracting</span>
                </div>
              )}
            </section>
          )}

          {/* ── Sessions ───────────────────────────────────────────────── */}
          {sessions.length > 0 && (
            <section style={cardStyle}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <CardTitle
                  title="Sessions"
                  sub={`${visibleSessions.length} of ${sessions.length} · ${formatDuration(
                    visibleSessions.reduce((s, x) => s + durationMs(x.start_ts, x.end_ts) / 1000, 0),
                  )}`}
                />
                {appOptions.length > 1 && (
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      maxWidth: "100%",
                      minWidth: 0,
                      fontSize: 12,
                      color: "var(--tx-3)",
                    }}
                  >
                    App
                    <select
                      value={filterValue}
                      onChange={(e) => setAppFilter(e.target.value)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--line)",
                        background: "var(--card-2, transparent)",
                        color: "var(--tx-2)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        maxWidth: "100%",
                        minHeight: 44,
                        minWidth: 0,
                      }}
                    >
                      <option value="all">All apps</option>
                      {appOptions.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
                {visibleSessions.map((seg, i) => {
                  const title = seg.title || seg.summary || seg.app || "Untitled stretch";
                  const distracting = (seg.distraction_score ?? 0) >= 0.5;
                  return (
                    <button
                      key={seg.id}
                      onClick={() => onSeek(seg.start_ts)}
                      title={`Replay from ${timeIn(timezone, seg.start_ts)}`}
                      style={{
                        ...sessionRowStyle,
                        borderTop: i === 0 ? "none" : "1px solid var(--line)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--card-2, rgba(255,255,255,0.03))")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ width: 76, flexShrink: 0 }}>
                        <span
                          style={{
                            display: "block",
                            fontFamily: "var(--mono)",
                            fontSize: 12.5,
                            color: "var(--tx)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {timeIn(timezone, seg.start_ts)}
                        </span>
                        <span
                          style={{
                            display: "block",
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            color: "var(--tx-3)",
                            marginTop: 2,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatDuration(durationMs(seg.start_ts, seg.end_ts) / 1000)}
                        </span>
                      </span>
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 3,
                          background: catColor(seg.category),
                          flexShrink: 0,
                          marginTop: 4,
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: 13.5,
                            lineHeight: 1.45,
                            color: "var(--tx)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={title}
                        >
                          {title}
                        </span>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                            minWidth: 0,
                            marginTop: 4,
                            fontSize: 11.5,
                            color: "var(--tx-3)",
                          }}
                        >
                          <span>{seg.source === "ai" ? "AI-derived" : seg.source === "rule" ? "Rule-derived" : "Derived activity"}</span>
                          {seg.app && (
                            <span
                              style={{
                                fontFamily: "var(--mono)",
                                background: "var(--card-3, rgba(255,255,255,0.06))",
                                borderRadius: 5,
                                padding: "1px 7px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: 220,
                              }}
                            >
                              {seg.app}
                            </span>
                          )}
                          <span>
                            {timeIn(timezone, seg.start_ts)} → {timeIn(timezone, seg.end_ts)}
                          </span>
                          {distracting && (
                            <span
                              style={{
                                color: "var(--afk, #fbbf24)",
                                border: "1px solid currentColor",
                                borderRadius: 5,
                                padding: "0 6px",
                                fontSize: 10.5,
                                whiteSpace: "nowrap",
                              }}
                            >
                              distracting
                            </span>
                          )}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        style={{
                          flexShrink: 0,
                          fontSize: 16,
                          color: "var(--tx-3)",
                        }}
                      >
                        ›
                      </span>
                    </button>
                  );
                })}
                {visibleSessions.length === 0 && (
                  <Box color="text-body-secondary" fontSize="body-s">
                    No sessions for this filter.
                  </Box>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: "20px 22px",
};

const trackStyle: React.CSSProperties = {
  height: 8,
  borderRadius: 4,
  background: "var(--line)",
  overflow: "hidden",
};

const fillStyle: React.CSSProperties = {
  display: "block",
  height: "100%",
  borderRadius: 4,
  opacity: 0.9,
};

function highlightStyle(color: string): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "12px 14px 12px 16px",
    borderRadius: 12,
    border: "1px solid var(--line)",
    borderLeft: `3px solid ${color}`,
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
  };
}

const sessionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  width: "100%",
  textAlign: "left",
  padding: "12px 8px",
  background: "transparent",
  border: "none",
  borderRadius: 8,
  color: "var(--tx)",
  cursor: "pointer",
};

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 12,
        padding: "12px 14px",
        background: "var(--card-2, transparent)",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--tx-3)",
          marginBottom: 6,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 21,
          fontWeight: 650,
          letterSpacing: "-0.01em",
          color: accent ?? "var(--tx)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={value}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 4,
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--tx-3)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={sub}
      >
        {sub}
      </div>
    </div>
  );
}

function CardTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 650,
          letterSpacing: "-0.005em",
          color: "var(--tx)",
        }}
      >
        {title}
      </div>
      {sub && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--tx-3)" }}>{sub}</div>
      )}
    </div>
  );
}
