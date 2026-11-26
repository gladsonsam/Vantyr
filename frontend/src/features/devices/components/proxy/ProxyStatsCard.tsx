import { useState } from "react";
import Counter from "@/components/react-bits/Counter";
import { StatCard } from "@/components/common/StatCard";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useProxyStatsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { StatsRange } from "@/features/network/runtime/types";
import { QueryChart } from "../dns/QueryChart";
import { TopDomains } from "../dns/TopDomains";
import { RangePicker } from "../RangePicker";

function Figure({ value }: { value: number }) {
  return <Counter value={value} fontSize={24} fontWeight={600} textColor="currentColor" />;
}

/** How many requests this device sent through the proxy and how many were blocked, over a chosen range. */
export function ProxyStatsCard({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useProxyStatsQuery({ deviceId, range });
  const picker = <RangePicker value={range} onChange={setRange} />;

  if (query.isPending) {
    return (
      <div className="space-y-6">
        {picker}
        <div className="h-52" />
      </div>
    );
  }
  if (query.isError) {
    return <UnavailableSection title="Requests" reason="Couldn’t load the statistics." />;
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Requests" reason={query.data.reason} />;
  }
  const stats = query.data.data;
  const allowed = stats.total - stats.blocked;
  const inspectedShare = stats.total === 0 ? 0 : (stats.inspected / stats.total) * 100;
  const pct = (part: number) =>
    stats.total === 0 ? "0%" : `${Math.round((part / stats.total) * 100)}%`;
  const totals = stats.series.map((bucket) => bucket.total);
  const allowedSeries = stats.series.map((bucket) => bucket.total - bucket.blocked);
  const blockedSeries = stats.series.map((bucket) => bucket.blocked);

  return (
    <div className="space-y-6">
      {picker}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Requests"
          value={<Figure value={stats.total} />}
          trend={totals}
          hue="text-primary"
        />
        <StatCard
          label="Allowed"
          value={<Figure value={allowed} />}
          delta={pct(allowed)}
          trend={allowedSeries}
          hue="text-info"
        />
        <StatCard
          label="Blocked"
          value={<Figure value={stats.blocked} />}
          delta={pct(stats.blocked)}
          trend={blockedSeries}
          hue="text-destructive"
        />
        <StatCard
          label="HTTPS inspected"
          value={`${inspectedShare.toFixed(inspectedShare === 0 || inspectedShare === 100 ? 0 : 1)}%`}
          trend={stats.series.map((bucket) => (stats.inspected === 0 ? 0 : bucket.total))}
          hue="text-warning"
        />
      </div>
      <div className="rounded-xl border border-border/70 bg-card/10 p-5">
        <QueryChart series={stats.series} title="Requests over time" noun="requests" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopDomains title="Top hosts" rows={stats.topHosts} tone="neutral" total={allowed} />
        <TopDomains
          title="Top blocked hosts"
          rows={stats.topBlocked}
          tone="blocked"
          total={stats.blocked}
        />
      </div>
    </div>
  );
}
