import { useEffect, useId, useMemo, useState } from "react";
import { Spinner } from "@vantyr/ui/components/spinner";
import { RecallDayPicker } from "./RecallDayPicker";
import type { RecallDayContext } from "./RecallView";
import { catColor, catLabel, formatDuration, parseDayLocal, timeIn } from "@/features/recall/lib/recallFormat";

/** Segments shorter than this are dropped from the session list as alt-tab noise. */
const MIN_SESSION_MS = 60 * 1000;

function durationMs(startTs: string, endTs: string): number {
  return Math.max(0, new Date(endTs).getTime() - new Date(startTs).getTime());
}

/**
 * The day panel: what happened, in what proportion, and where to look.
 *
 * A header card carries the narrative and the day picker; breakdown, highlights,
 * the day timeline and the session list follow as cards. Everything seeks the
 * player. Status is carried by plain text — no pill badges — and cards use the
 * flat `bg-card` / inner `bg-muted/50` surfaces with row dividers.
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
    <div className="flex flex-col gap-6">
      {/* ── Header + narrative ─────────────────────────────────────────── */}
      <section className="rounded-xl bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 flex-1 basis-70">
            <div className="text-xl font-semibold tracking-tight">
              {dayLabel}
              {timezone && (
                <span
                  className="ml-2.5 font-mono text-xs font-normal text-muted-foreground"
                  title="Days are bucketed in the agent's timezone"
                >
                  {timezone}
                </span>
              )}
            </div>
            {summary?.narrative && (
              <div className="mt-2 text-xs text-muted-foreground">
                {summary.source === "rule" ? "Rule-derived inference" : "Derived narrative"}
              </div>
            )}
            {summary?.narrative && (
              <p className="mt-3 max-w-180 text-sm leading-relaxed text-muted-foreground">
                {summary.narrative}
              </p>
            )}
          </div>
          {summary?.narrative && <p className="m-0 max-w-100 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
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
          <div className="flex items-center gap-2 pt-4 text-sm text-muted-foreground">
            <Spinner /> Loading day summary…
          </div>
        ) : (
          !empty && (
            <p className="pt-4 font-mono text-xs text-muted-foreground">
              {formatDuration(activeSecs)} active · {totals?.segment_count ?? segments.length} sessions
              {byCategory.rows[0] ? ` · top ${catLabel(byCategory.rows[0].cat)} ${Math.round(byCategory.rows[0].pct)}%` : ""}
              {focusPct != null ? ` · focus ${focusPct}%` : ""}
              {filterValue !== "all" ? ` · filtered: ${filterValue}` : ""}
            </p>
          )
        )}
      </section>

      {loading ? null : empty ? (
        <section className="rounded-xl bg-card p-5">
          <p className="text-sm text-muted-foreground">
            {dayError ? "Could not load the day summary and activity. Recording coverage is shown separately; choose another date or reload to retry." : "No derived summary or activity for this day. Check retained recording coverage above."}
          </p>
        </section>
      ) : (
        <>
          {/* ── Breakdown ──────────────────────────────────────────────── */}
          {(byCategory.rows.length > 0 || topApps.length > 0) && (
            <div className="grid gap-6 md:grid-cols-2">
              {byCategory.rows.length > 0 && (
                <section className="rounded-xl bg-card p-5">
                  <CardTitle
                    title="Where the time went"
                    sub={`${formatDuration(byCategory.total)} active`}
                  />
                  <div className="mt-3.5 flex flex-col gap-3">
                    {byCategory.rows.map((r) => (
                      <div key={r.cat}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2.5">
                          <span className="flex items-center gap-2 text-[13.5px] font-semibold">
                            <span
                              aria-hidden="true"
                              className="size-2.5 shrink-0 rounded-[3px]"
                              style={{ background: catColor(r.cat) }}
                            />
                            {catLabel(r.cat)}
                          </span>
                          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                            {formatDuration(r.secs)} · {Math.round(r.pct)}%
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted/70">
                          <span className="block h-full rounded-full opacity-90" style={{ width: `${r.pct}%`, background: catColor(r.cat) }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {topApps.length > 0 && (
                <section className="rounded-xl bg-card p-5">
                  <CardTitle title="Top apps" sub="share of active time" />
                  <div className="mt-3.5 flex flex-col gap-3">
                    {topApps.map((a) => (
                      <div key={a.app}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2.5">
                          <span
                            title={a.app}
                            className="max-w-[60%] overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap"
                          >
                            {a.app}
                          </span>
                          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                            {formatDuration(a.seconds)} · {Math.round(a.pct)}%
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted/70" title={`${a.app} · ${formatDuration(a.seconds)} (${Math.round(a.pct)}% of active)`}>
                          <span className="block h-full rounded-full bg-success opacity-90" style={{ width: `${Math.max(2, a.pct)}%` }} />
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
            <section className="rounded-xl bg-card p-5">
              <CardTitle title="Highlights" sub="derived activity — open source time" />
              <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {highlights.slice(0, 6).map((h) => {
                  const secs = durationMs(h.start_ts, h.end_ts) / 1000;
                  return (
                    <button
                      key={`${h.start_ts}-${h.label}`}
                      onClick={() => onSeek(h.start_ts)}
                      title={`Replay from ${timeIn(timezone, h.start_ts)}`}
                      className="flex min-h-11 cursor-pointer flex-col gap-2 rounded-lg bg-muted/50 p-3 pl-3.5 text-left hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      style={{ borderLeft: `3px solid ${catColor(h.category)}` }}
                    >
                      <span className="flex items-center gap-2">
                        <span className="rounded-md bg-muted/70 px-2 py-0.5 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground">
                          {timeIn(timezone, h.start_ts)}
                        </span>
                        <span className="font-mono text-[11.5px] whitespace-nowrap text-muted-foreground">
                          {formatDuration(secs)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[13px] leading-snug">
                        {h.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
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
            <section className="rounded-xl bg-card p-5">
              <CardTitle
                title="Day timeline"
                sub={`${sourceSegments.length} activity segments · choose any source time below`}
              />
              <label htmlFor={segmentChooserId} className="mt-3.5 grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                Open segment source time
                <select id={segmentChooserId} value="" onChange={event => {
                  const segment = sourceSegments.find(s => String(s.id) === event.target.value);
                  if (segment) onSeek(segment.start_ts);
                }} style={{ width: "100%", maxWidth: "100%", minWidth: 0, minHeight: 44, boxSizing: "border-box", padding: "8px", borderRadius: 8, border: "1px solid var(--input)", background: "var(--muted)", color: "var(--foreground)", fontSize: 16 }}>
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
                className="mt-3.5 flex h-5 gap-[3px]"
              >
                {sourceSegments.map((seg) => (
                  <span
                    key={seg.id}
                    aria-hidden="true"
                    title={`${timeIn(timezone, seg.start_ts)} → ${timeIn(timezone, seg.end_ts)} · ${catLabel(seg.category)} · ${formatDuration(durationMs(seg.start_ts, seg.end_ts) / 1000)}`}
                    className="h-full min-w-0 rounded"
                    style={{ flex: durationMs(seg.start_ts, seg.end_ts), background: catColor(seg.category), opacity: 1 - seg.distraction_score * 0.55 }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex justify-between gap-2 font-mono text-[11px] text-muted-foreground">
                <span>{timeIn(timezone, sourceSegments[0].start_ts)}</span>
                <span>{timeIn(timezone, sourceSegments[sourceSegments.length - 1].end_ts)}</span>
              </div>
              {legendCats.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-3.5 text-xs text-muted-foreground">
                  {legendCats.map((c) => (
                    <span key={c} className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="size-2 rounded-[3px]"
                        style={{ background: catColor(c) }}
                      />
                      {catLabel(c)}
                    </span>
                  ))}
                  <span className="text-muted-foreground">faded = distracting</span>
                </div>
              )}
            </section>
          )}

          {/* ── Sessions ───────────────────────────────────────────────── */}
          {sessions.length > 0 && (
            <section className="rounded-xl bg-card p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <CardTitle
                  title="Sessions"
                  sub={`${visibleSessions.length} of ${sessions.length} · ${formatDuration(
                    visibleSessions.reduce((s, x) => s + durationMs(x.start_ts, x.end_ts) / 1000, 0),
                  )}`}
                />
                {appOptions.length > 1 && (
                  <label className="flex max-w-full min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    App
                    <select
                      value={filterValue}
                      onChange={(e) => setAppFilter(e.target.value)}
                      className="h-9 max-w-full min-w-0 rounded-lg bg-muted/70 px-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

              <div className="mt-2 flex flex-col divide-y divide-foreground/[0.06]">
                {visibleSessions.map((seg) => {
                  const title = seg.title || seg.summary || seg.app || "Untitled stretch";
                  const distracting = (seg.distraction_score ?? 0) >= 0.5;
                  return (
                    <button
                      key={seg.id}
                      onClick={() => onSeek(seg.start_ts)}
                      title={`Replay from ${timeIn(timezone, seg.start_ts)}`}
                      className="flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="w-19 shrink-0">
                        <span className="block font-mono text-xs whitespace-nowrap tabular-nums">
                          {timeIn(timezone, seg.start_ts)}
                        </span>
                        <span className="mt-0.5 block font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                          {formatDuration(durationMs(seg.start_ts, seg.end_ts) / 1000)}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="mt-1 size-2 shrink-0 rounded-[3px]"
                        style={{ background: catColor(seg.category) }}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block overflow-hidden text-[13.5px] leading-snug text-ellipsis whitespace-nowrap"
                          title={title}
                        >
                          {title}
                        </span>
                        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                          <span>{seg.source === "rule" ? "Rule-derived" : "Derived activity"}</span>
                          {seg.app && (
                            <span className="max-w-55 overflow-hidden rounded-md bg-muted/70 px-1.5 py-px font-mono text-ellipsis whitespace-nowrap">
                              {seg.app}
                            </span>
                          )}
                          <span>
                            {timeIn(timezone, seg.start_ts)} → {timeIn(timezone, seg.end_ts)}
                          </span>
                          {distracting && (
                            <span className="whitespace-nowrap text-warning">
                              distracting
                            </span>
                          )}
                        </span>
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-base text-muted-foreground">
                        ›
                      </span>
                    </button>
                  );
                })}
                {visibleSessions.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">
                    No sessions for this filter.
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function CardTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2.5">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {sub && (
        <div className="font-mono text-[11.5px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}
