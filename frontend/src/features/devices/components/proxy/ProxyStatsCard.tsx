import { useState } from "react";
import { HelpTip } from "@/components/common/HelpTip";
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

/** How many times the proxy observed this device reaching a host, and how many were blocked, over a chosen range. */
export function ProxyStatsCard({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useProxyStatsQuery({ deviceId, range });

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
  const allowed = observed - blocked;
  const inspectedShare = observed === 0 ? 0 : (stats.inspected / observed) * 100;
  const pct = (part: number) => (observed === 0 ? "0%" : `${Math.round((part / observed) * 100)}%`);
  const totals = stats.series.map((bucket) => bucket.total);
  const allowedSeries = stats.series.map((bucket) => bucket.total - bucket.blocked);
  const blockedSeries = stats.series.map((bucket) => bucket.blocked);

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
          label="Inspected traffic"
          value={`${inspectedShare.toFixed(inspectedShare === 0 || inspectedShare === 100 ? 0 : 1)}%`}
          trend={stats.series.map((bucket) => (stats.inspected === 0 ? 0 : bucket.total))}
          hue="text-warning"
        />
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[0.8125rem] text-muted-foreground">
        Host observations by the proxy
        <HelpTip label="About these counts">
          Each count is how many times a host was observed, not a visit or a page view. Vantyr does
          not keep browser history, and only hostnames are recorded, never full URLs.
        </HelpTip>
        <span aria-hidden="true">·</span>
        Inspected traffic is what was observed
        <HelpTip label="About inspected traffic">
          The share of observations seen as inspected. It is observed traffic, not verified
          coverage: it does not show that everything from this device is inspected.
        </HelpTip>
      </p>
      <div className="rounded-xl border border-border/70 bg-card/10 p-5">
        <QueryChart
          series={stats.series}
          title="Observations over time"
          noun="observations"
          window={stats.window}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopDomains title="Top hosts" rows={stats.topHosts} tone="neutral" total={allowed} />
        <TopDomains
          title="Top blocked hosts"
          rows={stats.topBlocked}
          tone="blocked"
          total={blocked}
        />
      </div>
    </div>
  );
}
