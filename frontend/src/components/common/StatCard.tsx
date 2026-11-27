import type { ReactNode } from "react";
import { Sparkline } from "@/components/common/Sparkline";
import { cn } from "@/lib/utils";

/**
 * An outlined figure card: the number top left, a small delta top right, a trend line across the
 * bottom, and the label in the card's hue underneath. `hue` is a text-* class (e.g. text-info).
 */
export function StatCard({
  label,
  value,
  delta,
  trend,
  trendMax,
  hue,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  /** Omit when there is no per-bucket data: no trend is ever invented. */
  trend?: number[];
  trendMax?: number;
  hue: string;
}) {
  return (
    <div className="min-w-0 space-y-3">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
        <div className={cn("flex items-start justify-between gap-2 px-5 pt-5", hue)}>
          <div className="min-w-0 truncate text-3xl font-semibold tabular-nums tracking-tight text-foreground">
            {value}
          </div>
          {delta ? <span className="text-sm font-medium tabular-nums">{delta}</span> : null}
        </div>
        {trend ? (
          <Sparkline values={trend} max={trendMax} className={cn("mt-4 block h-16 w-full", hue)} />
        ) : (
          <div className="h-5" />
        )}
      </div>
      <div className={cn("px-1 text-base font-medium", hue)}>{label}</div>
    </div>
  );
}
