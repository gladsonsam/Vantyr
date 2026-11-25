import { useId, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vantyr/ui/components/popover";
import { useRecallEvidenceNote } from "@/features/recall/hooks/useRecallEvidenceNote";
import { recallQueries } from "@/api/queries/recall";
import type { HistoryDay } from "@/api/types";
import {
  addCalendarDays,
  dayRange,
  parseDayLocal,
  timeIn,
  todayIso,
} from "@/features/recall/lib/recallFormat";

/** Keep the visual coverage overview dense; day selection has full-size controls. */
const WEEKS = 12;
export interface RecallDayPickerProps {
  agentId: string;
  /** Selected calendar date in the recording device's zone. */
  day: string;
  onChange: (day: string) => void;
  timezone: string | null;
  /** Verified account/device scope from RecallView; null pauses requests. */
  coverageScope?: string | null;
  onSeek?: (iso: string) => void;
}
const NO_DAYS: HistoryDay[] = [];
const controlStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  maxWidth: "100%",
  boxSizing: "border-box",
  padding: "5px 8px",
  borderRadius: 8,
  border: "1px solid var(--input)",
  background: "var(--muted)",
  color: "var(--foreground)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 16,
};

function useRecordedCoverage({
  agentId,
  day,
  timezone,
  coverageScope,
}: RecallDayPickerProps) {
  const coverageQuery = useQuery({
    ...recallQueries.days(agentId, coverageScope),
    enabled: coverageScope !== null,
  });
  const status = coverageStatus(
    coverageQuery.isFetching || coverageScope === null,
    coverageQuery.isError,
    Boolean(coverageQuery.data),
  );
  const days =
    status === "ready" ? (coverageQuery.data?.days ?? NO_DAYS) : NO_DAYS;
  const today = todayIso(timezone ?? undefined);
  const covered = useMemo(
    () =>
      days
        .filter((d) => d.frame_count > 0 && d.day <= today)
        .sort((a, b) => a.day.localeCompare(b.day)),
    [days, today],
  );
  const byDay = useMemo(
    () => new Map(covered.map((d) => [d.day, d])),
    [covered],
  );
  const maxCount = useMemo(
    () => covered.reduce((max, d) => Math.max(max, d.frame_count), 1),
    [covered],
  );
  const columns = useMemo(() => {
    // Weekday and addition both use the device's calendar date without converting
    // through the viewer's local timezone (including DST or skipped local dates).
    const trailing = 6 - new Date(`${today}T12:00:00Z`).getUTCDay();
    const last = addCalendarDays(today, trailing);
    return Array.from({ length: WEEKS }, (_, col) =>
      Array.from({ length: 7 }, (_, row) =>
        addCalendarDays(last, -(WEEKS * 7 - 1) + col * 7 + row),
      ),
    );
  }, [today]);
  const selected = byDay.get(day);
  const response = status === "ready" ? coverageQuery.data : undefined;
  const responseZone = response?.timezone ?? timezone;
  const { outside, partialDay } = selectedCoverageBounds(
    day,
    responseZone,
    response,
  );
  const previous = covered
    .slice()
    .reverse()
    .find((d) => d.day < day)?.day;
  const next = covered.find((d) => d.day > day)?.day;
  return {
    coverageQuery,
    status,
    today,
    covered,
    byDay,
    maxCount,
    columns,
    selected,
    responseZone,
    outside,
    partialDay,
    previous,
    next,
  };
}
type Coverage = ReturnType<typeof useRecordedCoverage>;
function coverageStatus(
  loading: boolean,
  failed: boolean,
  available: boolean,
): "loading" | "ready" | "failed" {
  if (loading) return "loading";
  if (failed) return "failed";
  return available ? "ready" : "loading";
}
/** Recorded-day selection plus a compact, noninteractive coverage overview. */
export function RecallDayPicker(props: RecallDayPickerProps) {
  const { day, onChange, onSeek } = props;
  const id = useId();
  const evidenceNote = useRecallEvidenceNote();
  const coverage = useRecordedCoverage(props);
  const { byDay, status, covered, today, previous, next, responseZone } =
    coverage;

  return (
    <div
      className="recall-day-picker"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        flexWrap: "wrap",
        minWidth: 0,
        maxWidth: "100%",
        width: "100%",
      }}
    >
      <CoverageGrid id={id} day={day} coverage={coverage} />
      <div
        style={{
          flex: "1 1 220px",
          minWidth: 0,
          maxWidth: "100%",
          display: "grid",
          gap: 8,
        }}
      >
        <label
          htmlFor={`${id}-recorded`}
          className="grid min-w-0 gap-1 text-xs text-muted-foreground"
        >
          Recorded day
          <select
            id={`${id}-recorded`}
            value={byDay.has(day) ? day : ""}
            disabled={status !== "ready" || covered.length === 0}
            aria-describedby={`${id}-status`}
            onChange={(event) => {
              if (event.target.value) onChange(event.target.value);
            }}
            style={{ ...controlStyle, width: "100%" }}
          >
            <option value="">Choose a recorded day</option>
            {covered.map((row) => (
              <option key={row.day} value={row.day}>
                {row.day} · {row.frame_count} frames
              </option>
            ))}
          </select>
        </label>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 6,
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          <Button
            variant="outline"
            onClick={() => {
              if (previous) onChange(previous);
            }}
            disabled={!previous}
            aria-label="Previous recorded day"
            style={{
              minHeight: 44,
              width: 44,
              height: 44,
              flex: "0 0 44px",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ‹
          </Button>
          <label
            htmlFor={`${id}-date`}
            className="grid min-w-0 flex-1 gap-1 text-xs text-muted-foreground"
          >
            Calendar date
            <input
              id={`${id}-date`}
              type="date"
              value={day}
              max={today}
              onChange={(event) => {
                if (event.target.value) onChange(event.target.value);
              }}
              style={{ ...controlStyle, width: "100%" }}
            />
          </label>
          <Button
            variant="outline"
            onClick={() => {
              if (next) onChange(next);
            }}
            disabled={!next}
            aria-label="Next recorded day"
            style={{
              minHeight: 44,
              width: 44,
              height: 44,
              flex: "0 0 44px",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ›
          </Button>
        </div>
        <CoverageStatus id={id} coverage={coverage} />
        <SelectedDayEvidence
          day={day}
          coverage={coverage}
          onSeek={onSeek}
          evidenceNote={evidenceNote}
        />
        {responseZone ? null : (
          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Device timezone unavailable; dates use your browser timezone.
          </span>
        )}
      </div>
    </div>
  );
}

function CoverageGrid({
  id,
  day,
  coverage,
}: {
  id: string;
  day: string;
  coverage: Coverage;
}) {
  const { columns, byDay, status, today, maxCount } = coverage;
  return (
    <div style={{ minWidth: 0, maxWidth: "100%" }}>
      <div
        id={`${id}-coverage`}
        className="mb-1.5 text-xs text-muted-foreground"
      >
        Last 12 weeks of retained recordings
      </div>
      <div
        role="img"
        aria-labelledby={`${id}-coverage`}
        aria-describedby={`${id}-status`}
        style={{ display: "flex", gap: 2, width: 154, maxWidth: "100%" }}
      >
        {columns.map((column, col) => (
          <div
            key={col}
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            {column.map((date) => {
              const row = byDay.get(date),
                future = date > today;
              return (
                <span
                  key={date}
                  aria-hidden="true"
                  title={
                    status !== "ready"
                      ? `${date} · coverage unavailable`
                      : row
                        ? `${date} · ${row.frame_count} frames`
                        : `${date} · no retained recordings reported`
                  }
                  style={{
                    display: "block",
                    width: 11,
                    height: 11,
                    boxSizing: "border-box",
                    borderRadius: 2,
                    border:
                      date === day
                        ? "1px solid var(--foreground)"
                        : "1px solid transparent",
                    background: row
                      ? `color-mix(in srgb, var(--success) ${Math.round(22 + (row.frame_count / maxCount) * 78)}%, transparent)`
                      : "var(--muted)",
                    opacity: future || status !== "ready" ? 0.25 : 1,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function CoverageStatus({ id, coverage }: { id: string; coverage: Coverage }) {
  const { status, covered, coverageQuery } = coverage;
  return (
    <div
      id={`${id}-status`}
      role={status === "failed" ? "alert" : "status"}
      className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
    >
      {status === "loading" ? (
        "Loading recorded-day coverage…"
      ) : status === "failed" ? (
        <>
          Could not load recorded-day coverage.{" "}
          <button
            onClick={() => void coverageQuery.refetch()}
            style={controlStyle}
          >
            Retry coverage
          </button>
        </>
      ) : covered.length === 0 ? (
        "No recordings in this period. You can still pick a calendar date."
      ) : (
        `${covered.length} recorded days. Darker squares hold more frames.`
      )}
    </div>
  );
}

function SelectedDayEvidence({
  day,
  coverage,
  onSeek,
  evidenceNote,
}: {
  day: string;
  coverage: Coverage;
  onSeek?: (iso: string) => void;
  evidenceNote: ReturnType<typeof useRecallEvidenceNote>;
}) {
  const { status, selected, outside, partialDay } = coverage;
  return (
    <div
      aria-label="Selected day retained recordings"
      className="text-xs leading-relaxed [overflow-wrap:anywhere]"
    >
      {evidenceNote && <strong>{evidenceNote}</strong>}
      {status === "ready" && selected ? (
        <SelectedCoverage
          day={day}
          selected={selected}
          zone={coverage.responseZone}
          onSeek={onSeek}
        />
      ) : (
        coverageUnavailable(status, outside)
      )}
      {status === "ready" && partialDay && (
        <div>
          Coverage overlaps only part of this device calendar day; the rest of
          the day is unverified.
        </div>
      )}
    </div>
  );
}
function coverageUnavailable(status: Coverage["status"], outside: boolean) {
  if (status === "loading") return "Day coverage is loading.";
  if (status === "failed") return "Day coverage unavailable.";
  return outside
    ? "Selected day is outside the returned coverage period; retained recordings are unverified."
    : "No retained recordings reported for this day. A derived summary may still exist.";
}
function validCaptureTime(value: string | null | undefined): value is string {
  return Boolean(value) && Number.isFinite(Date.parse(value!));
}
function SelectedCoverage({
  day,
  selected,
  zone,
  onSeek,
}: {
  day: string;
  selected: HistoryDay;
  zone: string | null;
  onSeek?: (iso: string) => void;
}) {
  const first = validCaptureTime(selected.first_ts) ? selected.first_ts : null;
  const last = validCaptureTime(selected.last_ts) ? selected.last_ts : null;
  return (
    <>
      <strong>
        {selected.frame_count} retained frames on {day}, observed within the
        returned coverage period.
      </strong>
      <div>
        {first
          ? `First observed capture: ${timeIn(zone, first)}.`
          : "First observed capture time unavailable."}
        {last ? ` Last observed capture: ${timeIn(zone, last)}.` : ""}
      </div>
      {onSeek && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {first && (
            <button style={controlStyle} onClick={() => onSeek(first)}>
              Open first capture
            </button>
          )}
          {last && (
            <button style={controlStyle} onClick={() => onSeek(last)}>
              Open last capture
            </button>
          )}
        </div>
      )}
      <div>Observed captures, not continuous recording.</div>
    </>
  );
}
function selectedCoverageBounds(
  day: string,
  zone: string | null,
  response?: { from?: string; to?: string },
) {
  const range = dayRange(day, zone);
  const from = Date.parse(response?.from ?? ""),
    to = Date.parse(response?.to ?? "");
  const bounded = Number.isFinite(from) && Number.isFinite(to) && from < to;
  const outside = bounded && (range.fromMs >= to || range.toMs <= from);
  return {
    outside,
    partialDay: bounded && !outside && (from > range.fromMs || to < range.toMs),
  };
}

/** "Thu 26 Nov": short enough for a toolbar button, still names the weekday. */
function shortDayLabel(day: string): string {
  return parseDayLocal(day).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * The toolbar's day control: step to the neighbouring recorded day, or open the full picker
 * (coverage overview, recorded-day list, calendar) from the day itself.
 */
export function RecallDayStepper(props: RecallDayPickerProps) {
  const { day, onChange, onSeek } = props;
  const [open, setOpen] = useState(false);
  const coverage = useRecordedCoverage(props);
  const { previous, next, selected, status } = coverage;
  const detail =
    status !== "ready"
      ? null
      : selected
        ? `${selected.frame_count.toLocaleString()} captures`
        : "no captures";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        className="size-9 shrink-0"
        onClick={() => previous && onChange(previous)}
        disabled={!previous}
        aria-label="Earlier recorded day"
        title={previous ? `Go to ${shortDayLabel(previous)}` : "No earlier recorded day"}
      >
        <ChevronLeft />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="h-9 min-w-0 flex-1 justify-start gap-2 px-3 sm:flex-none"
              aria-label={`Day: ${shortDayLabel(day)}. Choose another day`}
            />
          }
        >
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{shortDayLabel(day)}</span>
          {detail && (
            <span className="hidden truncate text-xs text-muted-foreground min-[420px]:inline">
              {detail}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-[80dvh] w-[min(92vw,26rem)] overflow-y-auto p-3"
        >
          <RecallDayPicker
            {...props}
            onChange={(value) => {
              onChange(value);
              setOpen(false);
            }}
            onSeek={
              onSeek
                ? (iso) => {
                    onSeek(iso);
                    setOpen(false);
                  }
                : undefined
            }
          />
        </PopoverContent>
      </Popover>
      <Button
        variant="outline"
        size="icon"
        className="size-9 shrink-0"
        onClick={() => next && onChange(next)}
        disabled={!next}
        aria-label="Later recorded day"
        title={next ? `Go to ${shortDayLabel(next)}` : "No later recorded day"}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

/**
 * One line, only when the chosen day's coverage deserves a caution: no captures, a day the
 * coverage report does not reach, partial coverage or a failed lookup. Silent otherwise.
 */
export function RecallDayCoverageNote(props: RecallDayPickerProps) {
  const coverage = useRecordedCoverage(props);
  const { status, selected, outside, partialDay, coverageQuery } = coverage;
  let text: string | null = null;
  if (status === "failed") text = "Couldn't check which days have captures.";
  else if (status === "ready" && outside)
    text = "This day is outside the coverage the server reported, so captures are unverified.";
  else if (status === "ready" && !selected)
    text = "No captures were recorded on this day. An activity summary may still exist below.";
  else if (status === "ready" && partialDay)
    text = "Coverage reaches only part of this day. The rest is unverified.";
  if (!text) return null;
  return (
    <p
      role={status === "failed" ? "alert" : "status"}
      className="text-xs text-warning [overflow-wrap:anywhere]"
    >
      {text}
      {status === "failed" && (
        <Button
          variant="link"
          size="sm"
          className="h-auto px-1.5 py-0 text-xs"
          onClick={() => void coverageQuery.refetch()}
        >
          Retry
        </Button>
      )}
    </p>
  );
}
