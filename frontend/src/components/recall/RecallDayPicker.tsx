import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { isDemoMode } from "../../demo/mode";
import { api } from "../../lib/api";
import type { HistoryDay, HistoryDaysResponse } from "../../lib/types";
import { addCalendarDays, dayRange, timeIn, todayIso } from "./recallFormat";

/** Keep the visual coverage overview dense; day selection has full-size controls. */
const WEEKS = 12;
interface RecallDayPickerProps {
  agentId: string;
  /** Selected calendar date in the recording device's zone. */
  day: string;
  onChange: (day: string) => void;
  timezone: string | null;
  /** Verified account/device scope from RecallView; null pauses requests. */
  coverageScope?: string | null;
  onSeek?: (iso: string) => void;
}
type Coverage = { scope: string; status: "loading" | "ready" | "failed"; days: HistoryDay[]; response?: HistoryDaysResponse };
const controlStyle: CSSProperties = {
  minHeight: 44, minWidth: 0, maxWidth: "100%", boxSizing: "border-box",
  padding: "5px 8px", borderRadius: 8, border: "1px solid var(--line)",
  background: "var(--card)", color: "var(--tx-2)", fontFamily: "var(--font)", fontVariantNumeric: "tabular-nums", fontSize: 16,
};

/** Recorded-day selection plus a compact, noninteractive coverage overview. */
export function RecallDayPicker({ agentId, day, onChange, timezone, coverageScope, onSeek }: RecallDayPickerProps) {
  const id = useId();
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify([coverageScope, agentId, retry]);
  const [coverage, setCoverage] = useState<Coverage>({ scope, status: "loading", days: [] });
  const status = coverage.scope === scope ? coverage.status : "loading";
  const days = useMemo(() => coverage.scope === scope && coverage.status === "ready" ? coverage.days : [], [coverage, scope]);

  useEffect(() => {
    let alive = true;
    setCoverage({ scope, status: "loading", days: [] });
    if (coverageScope === null) return () => { alive = false; };
    api.historyDays(agentId, {}).then(res => {
      if (alive) setCoverage({ scope, status: "ready", days: res.days, response: res });
    }).catch(() => {
      if (alive) setCoverage({ scope, status: "failed", days: [] });
    });
    return () => { alive = false; };
  }, [agentId, scope, coverageScope]);

  const today = todayIso(timezone ?? undefined);
  const covered = useMemo(() => days.filter(d => d.frame_count > 0 && d.day <= today).sort((a, b) => a.day.localeCompare(b.day)), [days, today]);
  const byDay = useMemo(() => new Map(covered.map(d => [d.day, d])), [covered]);
  const maxCount = useMemo(() => covered.reduce((max, d) => Math.max(max, d.frame_count), 1), [covered]);
  const columns = useMemo(() => {
    // Weekday and addition both use the device's calendar date without converting
    // through the viewer's local timezone (including DST or skipped local dates).
    const trailing = 6 - new Date(`${today}T12:00:00Z`).getUTCDay();
    const last = addCalendarDays(today, trailing);
    return Array.from({ length: WEEKS }, (_, col) => Array.from({ length: 7 }, (_, row) => addCalendarDays(last, -(WEEKS * 7 - 1) + col * 7 + row)));
  }, [today]);
  const selected = byDay.get(day);
  const response = coverage.scope === scope && status === "ready" ? coverage.response : undefined;
  const responseZone = response?.timezone ?? timezone;
  const selectedRange = dayRange(day, responseZone);
  const fromMs = Date.parse(response?.from ?? ""), toMs = Date.parse(response?.to ?? "");
  const bounded = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;
  // History bounds are [from, to): midnight at `to` belongs to the next day,
  // which is unverified unless some of that calendar day overlaps the response.
  const outside = bounded && (selectedRange.fromMs >= toMs || selectedRange.toMs <= fromMs);
  const partialDay = bounded && !outside && (fromMs > selectedRange.fromMs || toMs < selectedRange.toMs);
  const previous = covered.slice().reverse().find(d => d.day < day)?.day;
  const next = covered.find(d => d.day > day)?.day;

  return <div className="recall-day-picker" style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", minWidth: 0, maxWidth: "100%", width: "100%" }}>
    <div style={{ minWidth: 0, maxWidth: "100%" }}>
      <div id={`${id}-coverage`} style={{ fontSize: 12, color: "var(--tx-3)", marginBottom: 6 }}>Last 12 weeks of retained recordings</div>
      <div role="img" aria-labelledby={`${id}-coverage`} aria-describedby={`${id}-status`} style={{ display: "flex", gap: 2, width: 154, maxWidth: "100%" }}>
        {columns.map((column, col) => <div key={col} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {column.map(date => {
            const row = byDay.get(date), future = date > today;
            return <span key={date} aria-hidden="true" title={status !== "ready" ? `${date} · coverage unavailable` : row ? `${date} · ${row.frame_count} frames` : `${date} · no retained recordings reported`}
              style={{ display: "block", width: 11, height: 11, boxSizing: "border-box", borderRadius: 2, border: date === day ? "1px solid var(--tx)" : "1px solid transparent", background: row ? `color-mix(in srgb, var(--gr) ${Math.round(22 + row.frame_count / maxCount * 78)}%, transparent)` : "var(--line)", opacity: future || status !== "ready" ? 0.25 : 1 }} />;
          })}
        </div>)}
      </div>
    </div>
    <div style={{ flex: "1 1 220px", minWidth: 0, maxWidth: "100%", display: "grid", gap: 8 }}>
      <label htmlFor={`${id}-recorded`} style={{ display: "grid", gap: 4, minWidth: 0 }}>Recorded day
        <select id={`${id}-recorded`} value={byDay.has(day) ? day : ""} disabled={status !== "ready" || covered.length === 0} aria-describedby={`${id}-status`} onChange={event => { if (event.target.value) onChange(event.target.value); }} style={{ ...controlStyle, width: "100%" }}>
          <option value="">Choose a recorded day</option>
          {covered.map(row => <option key={row.day} value={row.day}>{row.day} · {row.frame_count} frames{row.has_summary ? " · summarized" : ""}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, minWidth: 0, maxWidth: "100%" }}>
        <button onClick={() => { if (previous) onChange(previous); }} disabled={!previous} aria-label="Previous recorded day" style={dayNavStyle(!previous)}>‹</button>
        <label htmlFor={`${id}-date`} style={{ display: "grid", gap: 4, flex: "1 1 0", minWidth: 0 }}>Calendar date
          <input id={`${id}-date`} type="date" value={day} max={today} onChange={event => { if (event.target.value) onChange(event.target.value); }} style={{ ...controlStyle, width: "100%" }} />
        </label>
        <button onClick={() => { if (next) onChange(next); }} disabled={!next} aria-label="Next recorded day" style={dayNavStyle(!next)}>›</button>
      </div>
      <div id={`${id}-status`} role={status === "failed" ? "alert" : "status"} style={{ fontSize: 12, overflowWrap: "anywhere" }}>
        {status === "loading" ? "Loading recorded-day coverage…" : status === "failed" ? <>Could not load recorded-day coverage. <button onClick={() => setRetry(value => value + 1)} style={controlStyle}>Retry coverage</button></> : covered.length === 0 ? "No recordings found in the available coverage period. You can still choose a calendar date." : `${covered.length} recorded days available. Darker squares mean more frames; use Recorded day to choose.`}
      </div>
      <div aria-label="Selected day retained recordings" style={{ fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>
        {isDemoMode && <strong>Synthetic demo evidence. </strong>}
        {status === "loading" ? "Selected-day recording coverage is loading." : status === "failed" ? "Selected-day recording coverage is unavailable." : selected ? <>
          <strong>{selected.frame_count} retained frames on {day}, observed within the returned coverage period.</strong>
          <div>{selected.first_ts && Number.isFinite(Date.parse(selected.first_ts)) ? `First observed capture: ${timeIn(responseZone, selected.first_ts)}.` : "First observed capture time unavailable."}</div>
          <div>{selected.last_ts && Number.isFinite(Date.parse(selected.last_ts)) ? `Last observed capture: ${timeIn(responseZone, selected.last_ts)}.` : "Last observed capture time unavailable."}</div>
          {onSeek && <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {selected.first_ts && Number.isFinite(Date.parse(selected.first_ts)) && <button style={controlStyle} onClick={() => onSeek(selected.first_ts!)}>Open first capture</button>}
            {selected.last_ts && Number.isFinite(Date.parse(selected.last_ts)) && <button style={controlStyle} onClick={() => onSeek(selected.last_ts!)}>Open last capture</button>}
          </div>}
          <div>These are observed captures, not continuous recording. Counts include all displays within that period; first/last times are observations within it.</div>
        </> : outside ? "Selected day is outside the returned coverage period; retained recordings are unverified. Choose a recorded day or try playback for this date." : "No retained recordings reported for this day in the available coverage period. A summary may remain when recordings are missing or expired; the reason is unknown. Choose a recorded day to review available evidence."}
        {status === "ready" && partialDay && <div>The returned coverage period overlaps only part of this device calendar day; the rest of the day is unverified.</div>}
      </div>
      <span style={{ fontSize: 12, overflowWrap: "anywhere", color: "var(--tx-3)" }}>{responseZone ? `Device timezone: ${responseZone}` : "Device timezone unavailable; dates use your browser timezone."}</span>
    </div>
  </div>;
}
function dayNavStyle(disabled: boolean): CSSProperties {
  return { ...controlStyle, width: 44, height: 44, flex: "0 0 44px", padding: 0, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1, lineHeight: 1 };
}
