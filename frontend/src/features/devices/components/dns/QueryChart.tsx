import { useState } from "react";
import { fmtDateTime } from "@/lib/utils";
import type { DnsStats, StatsWindow } from "@/features/network/runtime/types";

export type ChartSeries = DnsStats["series"];

const W = 720;
const H = 160;

/**
 * Queries over time as stacked bars: allowed on the bottom, blocked on top. Dependency-free; hovering
 * a bar shows that bucket's counts.
 */
export function QueryChart({
  series,
  title = "Observations over time",
  noun = "observations",
  window,
}: {
  series: ChartSeries;
  /** What the data really covers: its start and end label the axis, never the requested range. */
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
  const startAt = window?.actualStart ?? first?.at;
  const endAt = window?.actualEnd ?? last?.at;
  const active = hover === null ? null : series[hover];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-primary" />
            Allowed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-destructive" />
            Blocked
          </span>
        </div>
      </div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-40 w-full"
          role="img"
          aria-label={`${title}, with blocked ${noun} marked`}
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
            const allowedHeight = ((bucket.total - bucket.blocked) / max) * (H - 4);
            const blockedHeight = (bucket.blocked / max) * (H - 4);
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
                <rect
                  x={x}
                  y={H - blockedHeight}
                  width={barWidth}
                  height={Math.max(blockedHeight, 0)}
                  rx={1.5}
                  className="fill-destructive"
                  opacity={hover === null || hover === index ? 1 : 0.55}
                />
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
            <div className="flex items-center gap-1.5 tabular-nums">
              <span className="size-2 rounded-sm bg-primary" />
              {(active.total - active.blocked).toLocaleString()} allowed
            </div>
            <div className="flex items-center gap-1.5 tabular-nums">
              <span className="size-2 rounded-sm bg-destructive" />
              {active.blocked.toLocaleString()} blocked
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{startAt ? fmtDateTime(startAt) : ""}</span>
        <span className="hidden sm:inline">{middle ? fmtDateTime(middle.at) : ""}</span>
        <span>{endAt ? fmtDateTime(endAt) : ""}</span>
      </div>
    </div>
  );
}
