import { useState } from "react";
import Counter from "@/components/react-bits/Counter";
import { HelpTip } from "@/components/common/HelpTip";
import { StatCard } from "@/components/common/StatCard";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { StatsRange } from "@/features/network/runtime/types";
import { RangePicker } from "../RangePicker";
import { QueryChart } from "./QueryChart";
import { seriesHasBlocked } from "./statsWindowText";
import { TopDomains } from "./TopDomains";

function Figure({ value }: { value: number }) {
  return <Counter value={value} fontSize={24} fontWeight={600} textColor="currentColor" />;
}

/**
 * How many times a gateway observed this device looking up a domain, and how many were blocked, over
 * a chosen range. These are observations of domains, not visits or browser history.
 */
export function QueriesCard({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useDnsStatsQuery({ deviceId, range });

  if (query.isPending) {
    return (
      <div className="space-y-6">
        <RangePicker value={range} onChange={setRange} />
        <div className="h-52" />
      </div>
    );
  }
  if (query.isError) {
    return <UnavailableSection title="Observations" reason="Couldn’t load the statistics." />;
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Observations" reason={query.data.reason} />;
  }
  const stats = query.data.data;
  const observed = stats.observations;
  const blocked = stats.blockedObservations;
  // The server's own totals; never derived from buckets.
  const allowed = stats.allowed ?? observed - blocked;
  const share = observed === 0 ? 0 : (blocked / observed) * 100;
  const totals = stats.series.map((bucket) => bucket.total);
  // Trends only where per-bucket blocked counts exist (the demo); the real server sends totals only.
  const split = seriesHasBlocked(stats.series);
  const allowedSeries = split
    ? stats.series.map((bucket) => bucket.total - (bucket.blocked ?? 0))
    : undefined;
  const blockedSeries = split ? stats.series.map((bucket) => bucket.blocked ?? 0) : undefined;
  const ratioSeries = split
    ? stats.series.map((bucket) =>
        bucket.total === 0 ? 0 : ((bucket.blocked ?? 0) / bucket.total) * 100,
      )
    : undefined;
  const pct = (part: number) => (observed === 0 ? "0%" : `${Math.round((part / observed) * 100)}%`);

  return (
    <div className="space-y-6">
      <RangePicker value={range} onChange={setRange} window={stats.window} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Observations"
          value={<Figure value={observed} />}
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
          value={<Figure value={blocked} />}
          delta={pct(blocked)}
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
      <p className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
        Domain lookups a gateway observed
        <HelpTip label="About these counts">
          Each count is how many times a domain was observed, not a visit or a page view. Vantyr
          does not keep browser history, and only hostnames are recorded, never full URLs.
          {split
            ? null
            : " The over-time chart shows observations per time bucket; the server does not split each bucket into allowed and blocked."}
        </HelpTip>
      </p>
      <div className="rounded-xl border border-border/70 bg-card/10 p-5">
        <QueryChart series={stats.series} window={stats.window} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopDomains title="Top domains" rows={stats.topDomains} tone="neutral" total={allowed} />
        <TopDomains
          title="Top blocked domains"
          rows={stats.topBlocked}
          tone="blocked"
          total={blocked}
        />
      </div>
    </div>
  );
}
