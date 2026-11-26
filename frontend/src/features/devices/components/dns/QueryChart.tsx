import { fmtDateTime } from "@/lib/utils";
import type { DnsStats } from "@/features/network/runtime/types";

const W = 720;
const H = 140;

/**
 * Queries over time as bars, with the blocked share stacked at the bottom. Dependency-free, like the
 * resource history chart: the shape matters here, exact values are in the summary above it.
 */
export function QueryChart({ series }: { series: DnsStats["series"] }) {
  const max = Math.max(1, ...series.map((bucket) => bucket.total));
  const gap = 3;
  const barWidth = (W - gap * (series.length - 1)) / series.length;
  const first = series[0];
  const last = series[series.length - 1];
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-36 w-full"
        role="img"
        aria-label="Queries over time, with blocked queries marked"
      >
        {series.map((bucket, index) => {
          const x = index * (barWidth + gap);
          const allowedHeight = ((bucket.total - bucket.blocked) / max) * (H - 4);
          const blockedHeight = (bucket.blocked / max) * (H - 4);
          return (
            <g key={bucket.at}>
              <title>{`${fmtDateTime(bucket.at)}: ${bucket.total.toLocaleString()} queries, ${bucket.blocked.toLocaleString()} blocked`}</title>
              <rect
                x={x}
                y={H - blockedHeight - allowedHeight}
                width={barWidth}
                height={Math.max(allowedHeight, 0)}
                rx={1.5}
                className="fill-primary/55"
              />
              <rect
                x={x}
                y={H - blockedHeight}
                width={barWidth}
                height={Math.max(blockedHeight, 0)}
                rx={1.5}
                className="fill-destructive"
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{first ? fmtDateTime(first.at) : ""}</span>
        <span>{last ? fmtDateTime(last.at) : ""}</span>
      </div>
    </div>
  );
}
