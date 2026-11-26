import type { ReactNode } from "react";
import { StatCard } from "@/components/common/StatCard";
import { useDnsStatsQuery, useProxyStatsQuery } from "@/features/network/runtime/useRuntimeQueries";

const pct = (part: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((part / total) * 100)}%`;

/** Coloured figures with a trend line each: this device's DNS over the last day. Nothing if it can't load. */
export function OverviewDnsStats({
  deviceId,
  leading = [],
}: {
  deviceId: string;
  /** Cards from the agent that share this row, before the DNS ones. */
  leading?: ReactNode[];
}) {
  const query = useDnsStatsQuery({ deviceId, range: "24h" });
  if (query.isPending) return leading.length > 0 ? <div className="grid grid-cols-2 gap-5">{leading}</div> : <div className="h-40" />;
  if (query.isError || query.data.state === "unavailable") {
    return leading.length > 0 ? <div className="grid grid-cols-2 gap-5">{leading}</div> : null;
  }
  const stats = query.data.data;
  const allowed = stats.total - stats.blocked;
  const top = stats.topBlocked[0];
  return (
    <div
      className={
        leading.length > 0
          ? "grid grid-cols-2 gap-5 lg:grid-cols-3"
          : top
            ? "grid grid-cols-2 gap-5 lg:grid-cols-4"
            : "grid grid-cols-2 gap-5 lg:grid-cols-3"
      }
    >
      {leading}
      <StatCard
        label="Queries"
        value={stats.total.toLocaleString()}
        trend={stats.series.map((b) => b.total)}
        hue="text-primary"
      />
      <StatCard
        label="Allowed"
        value={allowed.toLocaleString()}
        delta={pct(allowed, stats.total)}
        trend={stats.series.map((b) => b.total - b.blocked)}
        hue="text-info"
      />
      <StatCard
        label="Blocked"
        value={stats.blocked.toLocaleString()}
        delta={pct(stats.blocked, stats.total)}
        trend={stats.series.map((b) => b.blocked)}
        hue="text-destructive"
      />
      {top ? (
        <StatCard
          label="Top blocked"
          value={<span title={top.domain} className="block truncate text-xl leading-9">{top.domain}</span>}
          delta={`${top.count.toLocaleString()}×`}
          trend={stats.series.map((b) => b.blocked)}
          hue="text-warning"
        />
      ) : null}
    </div>
  );
}

/** The same four figures for a device that reaches us through the proxy and has no DNS of its own. */
export function OverviewProxyStats({ deviceId }: { deviceId: string }) {
  const query = useProxyStatsQuery({ deviceId, range: "24h" });
  if (query.isPending) return <div className="h-40" />;
  if (query.isError || query.data.state === "unavailable") return null;
  const stats = query.data.data;
  const allowed = stats.total - stats.blocked;
  const top = stats.topBlocked[0];
  return (
    <div className={top ? "grid grid-cols-2 gap-5 lg:grid-cols-4" : "grid grid-cols-2 gap-5 lg:grid-cols-3"}>
      <StatCard
        label="Requests"
        value={stats.total.toLocaleString()}
        trend={stats.series.map((b) => b.total)}
        hue="text-primary"
      />
      <StatCard
        label="Allowed"
        value={allowed.toLocaleString()}
        delta={pct(allowed, stats.total)}
        trend={stats.series.map((b) => b.total - b.blocked)}
        hue="text-info"
      />
      <StatCard
        label="Blocked"
        value={stats.blocked.toLocaleString()}
        delta={pct(stats.blocked, stats.total)}
        trend={stats.series.map((b) => b.blocked)}
        hue="text-destructive"
      />
      {top ? (
        <StatCard
          label="Top blocked"
          value={<span title={top.domain} className="block truncate text-xl leading-9">{top.domain}</span>}
          delta={`${top.count.toLocaleString()}×`}
          trend={stats.series.map((b) => b.blocked)}
          hue="text-warning"
        />
      ) : null}
    </div>
  );
}
