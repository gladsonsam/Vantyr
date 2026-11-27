import { useState } from "react";
import { RangePicker } from "@/features/devices/components/RangePicker";
import { shortenedWindowText } from "@/features/devices/components/dns/statsWindowText";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { StatsRange } from "@/features/network/runtime/types";
import { fmtDateTime } from "@/lib/utils";
import { UNLABELLED_DEVICE } from "./evidenceLib";

/**
 * Three figures for the household (or the chosen device): observations, blocked observations and
 * the window they really cover. Renders nothing when statistics aren't available.
 */
export function ActivityStats({
  deviceId,
  deviceLabels,
}: {
  deviceId?: string;
  /** Device id to label, from the household devices (or rows already loaded in scoped mode). */
  deviceLabels?: ReadonlyMap<string, string>;
}) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useDnsStatsQuery({ deviceId, range });
  if (query.isPending || query.isError || query.data.state === "unavailable") return null;
  const stats = query.data.data;
  const { window } = stats;
  const figure = "text-2xl font-semibold tabular-nums tracking-tight";
  const label = "text-xs text-muted-foreground";
  const allowed = stats.allowed ?? stats.observations - stats.blockedObservations;
  const startAt = window.requestedStart ?? window.actualStart;
  const endAt = window.requestedEnd ?? window.actualEnd;
  // Household-wide only: per-device stats have one device by definition.
  const topDevices = deviceId ? [] : (stats.topDevices ?? []);
  const unknown = deviceId ? undefined : stats.unknownDeviceQueries;
  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-card/10 p-5">
      <RangePicker value={range} onChange={setRange} window={window} />
      <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col-reverse justify-end">
          <dd className={figure}>{stats.observations.toLocaleString()}</dd>
          <dt className={label}>Observations</dt>
        </div>
        <div className="flex flex-col-reverse justify-end">
          <dd className={`${figure} text-info`}>{allowed.toLocaleString()}</dd>
          <dt className={label}>Allowed observations</dt>
        </div>
        <div className="flex flex-col-reverse justify-end">
          <dd className={`${figure} text-destructive`}>
            {stats.blockedObservations.toLocaleString()}
          </dd>
          <dt className={label}>Blocked observations</dt>
        </div>
        <div className="flex flex-col-reverse justify-end">
          <dd className="text-sm font-medium">
            {fmtDateTime(startAt)} – {fmtDateTime(endAt)}
          </dd>
          <dt className={label} title={window.shortened ? shortenedWindowText(window) : undefined}>
            Requested window · {window.retainedDays} {window.retainedDays === 1 ? "day" : "days"}{" "}
            retained
          </dt>
        </div>
      </dl>
      {unknown !== undefined ? (
        <p className="text-xs text-muted-foreground">
          Unrecognised device lookups: {unknown.toLocaleString()}
        </p>
      ) : null}
      {topDevices.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Top devices</h3>
          <ul className="space-y-1.5">
            {topDevices.map((entry) => {
              const name = deviceLabels?.get(entry.deviceId);
              return (
                <li key={entry.deviceId} className="flex items-center gap-2.5 text-sm">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                  <span className="min-w-0 flex-1 truncate">
                    {name ?? UNLABELLED_DEVICE}
                    {name ? null : (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {entry.deviceId.slice(0, 8)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums">{entry.count.toLocaleString()}</span>
                </li>
              );
            })}
          </ul>
          {stats.topTruncated?.devices ? (
            <p className="text-xs text-muted-foreground">Only the busiest devices are listed.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
