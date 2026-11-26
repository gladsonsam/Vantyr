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
  trend: number[];
  trendMax?: number;
  hue: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
        <div className={cn("flex items-start justify-between gap-2 px-4 pt-4", hue)}>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {value}
          </div>
          {delta ? <span className="text-xs font-medium tabular-nums">{delta}</span> : null}
        </div>
        <Sparkline
          values={trend}
          max={trendMax}
          className={cn("mt-3 block h-12 w-full", hue)}
        />
      </div>
      <div className={cn("px-1 text-sm font-medium", hue)}>{label}</div>
    </div>
  );
}
