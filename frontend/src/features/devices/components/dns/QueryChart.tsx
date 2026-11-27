import { useState } from "react";
import { fmtDateTime, parseTimestamp } from "@/lib/utils";
import { seriesHasBlocked } from "./statsWindowText";
import type { DnsStats, StatsWindow } from "@/features/network/runtime/types";

export type ChartSeries = DnsStats["series"];

const W = 720;
const H = 160;

/**
 * Observations over time as bars. When every bucket carries a blocked count (the demo) the bars stack
 * allowed under blocked; otherwise (the real server sends a total per bucket only) they are one series,
 * with no allowed/blocked split. Dependency-free; hovering a bar shows that bucket's counts.
 */
export function QueryChart({
  series,
  title = "Observations over time",
  noun = "observations",
  window,
}: {
  series: ChartSeries;
  /** The requested window labels the axis; actual timestamps never imply continuous coverage. */
  window?: StatsWindow;
  title?: string;
  /** What the buckets count, for the chart's accessible name. */
  noun?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((bucket) => bucket.total));
  const gap = 3;
  const barWidth = (W - gap * (series.length - 1)) / series.length;
  const first = series[0];
  const last = series[series.length - 1];
  const middle = series[Math.floor(series.length / 2)];
  const split = seriesHasBlocked(series);
  const startAt = window?.requestedStart ?? window?.actualStart ?? first?.at;
  const endAt = window?.requestedEnd ?? window?.actualEnd ?? last?.at;
  const startMs = parseTimestamp(startAt ?? "")?.getTime();
  const endMs = parseTimestamp(endAt ?? "")?.getTime();
  const midAt =
    startMs !== undefined && endMs !== undefined
      ? new Date((startMs + endMs) / 2).toISOString()
      : middle?.at;
  const active = hover === null ? null : series[hover];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-primary" />
            {split ? "Allowed" : "Observations"}
          </span>
          {split ? (
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-destructive" />
              Blocked
            </span>
          ) : null}
        </div>
      </div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-40 w-full"
          role="img"
          aria-label={
            split ? `${title}, with blocked ${noun} marked` : `${title}, ${noun} per time bucket`
          }
        >
          {[0.25, 0.5, 0.75].map((line) => (
            <line
              key={line}
              x1={0}
              x2={W}
              y1={H * line}
              y2={H * line}
              className="stroke-border/60"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.map((bucket, index) => {
            const x = index * (barWidth + gap);
            const blockedCount = split ? (bucket.blocked ?? 0) : 0;
            const allowedHeight = ((bucket.total - blockedCount) / max) * (H - 4);
            const blockedHeight = (blockedCount / max) * (H - 4);
            return (
              <g key={bucket.at} onMouseEnter={() => setHover(index)}>
                <rect x={x - gap / 2} y={0} width={barWidth + gap} height={H} fill="transparent" />
                <rect
                  x={x}
                  y={H - blockedHeight - allowedHeight}
                  width={barWidth}
                  height={Math.max(allowedHeight, 0)}
                  rx={1.5}
                  className="fill-primary"
                  opacity={hover === null || hover === index ? 1 : 0.55}
                />
                {split ? (
                  <rect
                    x={x}
                    y={H - blockedHeight}
                    width={barWidth}
                    height={Math.max(blockedHeight, 0)}
                    rx={1.5}
                    className="fill-destructive"
                    opacity={hover === null || hover === index ? 1 : 0.55}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
        {active ? (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-sm"
            style={{
              left: `${Math.min(88, Math.max(12, ((hover! + 0.5) / series.length) * 100))}%`,
            }}
          >
            <div className="mb-1 text-muted-foreground">{fmtDateTime(active.at)}</div>
            {split ? (
              <>
                <div className="flex items-center gap-1.5 tabular-nums">
                  <span className="size-2 rounded-sm bg-primary" />
                  {(active.total - (active.blocked ?? 0)).toLocaleString()} allowed
                </div>
                <div className="flex items-center gap-1.5 tabular-nums">
                  <span className="size-2 rounded-sm bg-destructive" />
                  {(active.blocked ?? 0).toLocaleString()} blocked
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5 tabular-nums">
                <span className="size-2 rounded-sm bg-primary" />
                {active.total.toLocaleString()} {noun}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{startAt ? fmtDateTime(startAt) : ""}</span>
        <span className="hidden sm:inline">{midAt ? fmtDateTime(midAt) : ""}</span>
        <span>{endAt ? fmtDateTime(endAt) : ""}</span>
      </div>
    </div>
  );
}
