import { useState } from "react";
import { RangePicker } from "@/features/devices/components/RangePicker";
import { shortenedWindowText } from "@/features/devices/components/dns/statsWindowText";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { StatsRange } from "@/features/network/runtime/types";
import { fmtDateTime } from "@/lib/utils";

/**
 * Three figures for the household (or the chosen device): observations, blocked observations and
 * the window they really cover. Renders nothing when statistics aren't available.
 */
export function ActivityStats({ deviceId }: { deviceId?: string }) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useDnsStatsQuery({ deviceId, range });
  if (query.isPending || query.isError || query.data.state === "unavailable") return null;
  const stats = query.data.data;
  const { window } = stats;
  const figure = "text-2xl font-semibold tabular-nums tracking-tight";
  const label = "text-xs text-muted-foreground";
  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-card/10 p-5">
      <RangePicker value={range} onChange={setRange} window={window} />
      <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <div className="flex flex-col-reverse justify-end">
          <dd className={figure}>{stats.observations.toLocaleString()}</dd>
          <dt className={label}>Observations</dt>
        </div>
        <div className="flex flex-col-reverse justify-end">
          <dd className={`${figure} text-destructive`}>
            {stats.blockedObservations.toLocaleString()}
          </dd>
          <dt className={label}>Blocked observations</dt>
        </div>
        <div className="flex flex-col-reverse justify-end">
          <dd className="text-sm font-medium">
            {fmtDateTime(window.actualStart)} – {fmtDateTime(window.actualEnd)}
          </dd>
          <dt className={label} title={window.shortened ? shortenedWindowText(window) : undefined}>
            {window.retainedDays} {window.retainedDays === 1 ? "day" : "days"} retained
          </dt>
        </div>
      </dl>
    </div>
  );
}
