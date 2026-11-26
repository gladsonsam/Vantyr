import { StatCard } from "@/components/common/StatCard";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";

const pct = (part: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((part / total) * 100)}%`;

/** Coloured figures with a trend line each: this device's DNS over the last day. Nothing if it can't load. */
export function OverviewDnsStats({ deviceId }: { deviceId: string }) {
  const query = useDnsStatsQuery({ deviceId, range: "24h" });
  if (query.isPending) return <div className="h-40" />;
  if (query.isError || query.data.state === "unavailable") return null;
  const stats = query.data.data;
  const allowed = stats.total - stats.blocked;
  const top = stats.topBlocked[0];
  return (
    <div className={top ? "grid grid-cols-2 gap-5 lg:grid-cols-4" : "grid grid-cols-2 gap-5 lg:grid-cols-3"}>
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
