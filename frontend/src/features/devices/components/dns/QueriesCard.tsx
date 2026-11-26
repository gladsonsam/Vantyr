import { useState } from "react";
import Counter from "@/components/react-bits/Counter";
import RubberSegment from "@/components/react-bits/RubberSegment";
import { StatCard } from "@/components/common/StatCard";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { StatsRange } from "@/features/network/runtime/types";
import { QueryChart } from "./QueryChart";
import { TopDomains } from "./TopDomains";

const RANGES: { key: StatsRange; label: string }[] = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

function Figure({ value }: { value: number }) {
  return <Counter value={value} fontSize={24} fontWeight={600} textColor="currentColor" />;
}

/** How many queries this device made and how many were blocked, over a chosen range. */
export function QueriesCard({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useDnsStatsQuery({ deviceId, range });

  const picker = (
    <div className="flex justify-end">
      <RubberSegment
        aria-label="Time range"
        items={RANGES.map((r) => ({ value: r.key, label: r.key }))}
        value={range}
        onChange={(next) => setRange(next as StatsRange)}
        size="sm"
        trackColor="var(--muted)"
        thumbColor="var(--primary)"
        textColor="var(--muted-foreground)"
        activeTextColor="var(--primary-foreground)"
      />
    </div>
  );

  if (query.isPending) {
    return (
      <div className="space-y-6">
        {picker}
        <div className="h-52" />
      </div>
    );
  }
  if (query.isError) {
    return <UnavailableSection title="Queries" reason="Couldn’t load the statistics." />;
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Queries" reason={query.data.reason} />;
  }
  const stats = query.data.data;
  const allowed = stats.total - stats.blocked;
  const share = stats.total === 0 ? 0 : (stats.blocked / stats.total) * 100;
  const totals = stats.series.map((bucket) => bucket.total);
  const allowedSeries = stats.series.map((bucket) => bucket.total - bucket.blocked);
  const blockedSeries = stats.series.map((bucket) => bucket.blocked);
  const ratioSeries = stats.series.map((bucket) =>
    bucket.total === 0 ? 0 : (bucket.blocked / bucket.total) * 100,
  );
  const pct = (part: number) => (stats.total === 0 ? "0%" : `${Math.round((part / stats.total) * 100)}%`);

  return (
    <div className="space-y-6">
      {picker}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Queries"
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
          label="Share blocked"
          value={`${share.toFixed(1)}%`}
          trend={ratioSeries}
          hue="text-warning"
        />
      </div>
      <div className="rounded-xl border border-border/70 bg-card/10 p-5">
        <QueryChart series={stats.series} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopDomains title="Top domains" rows={stats.topDomains} tone="neutral" total={stats.total} />
        <TopDomains
          title="Top blocked domains"
          rows={stats.topBlocked}
          tone="blocked"
          total={stats.blocked}
        />
      </div>
    </div>
  );
}
