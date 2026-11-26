import { StatCard } from "@/components/common/StatCard";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";

const pct = (part: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((part / total) * 100)}%`;

/** Four coloured figures with a trend line each: this device's DNS over the last day. Nothing if it can't load. */
export function OverviewDnsStats({ deviceId }: { deviceId: string }) {
  const query = useDnsStatsQuery({ deviceId, range: "24h" });
  if (query.isPending) return <div className="h-32" />;
  if (query.isError || query.data.state === "unavailable") return null;
  const stats = query.data.data;
  const allowed = stats.total - stats.blocked;
  const share = stats.total === 0 ? 0 : (stats.blocked / stats.total) * 100;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
      <StatCard
        label="Share blocked"
        value={`${share.toFixed(1)}%`}
        trend={stats.series.map((b) => (b.total === 0 ? 0 : (b.blocked / b.total) * 100))}
        trendMax={100}
        hue="text-warning"
      />
    </div>
  );
}
