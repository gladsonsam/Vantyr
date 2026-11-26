import { useState } from "react";
import { Card, CardContent } from "@vantyr/ui/components/card";
import Counter from "@/components/react-bits/Counter";
import RubberSegment from "@/components/react-bits/RubberSegment";
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

function Figure({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
        <Counter value={value} fontSize={30} fontWeight={600} textColor="currentColor" />
        {suffix}
      </div>
    </div>
  );
}

/** How many queries this device made and how many were blocked, over a chosen range. */
export function QueriesCard({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<StatsRange>("24h");
  const query = useDnsStatsQuery({ deviceId, range });

  const body = (() => {
    if (query.isPending) return <div className="h-52" />;
    if (query.isError) {
      return <UnavailableSection title="Queries" reason="Couldn’t load the statistics." />;
    }
    if (query.data.state === "unavailable") {
      return <UnavailableSection title="Queries" reason={query.data.reason} />;
    }
    const stats = query.data.data;
    const allowed = stats.total - stats.blocked;
    const share = stats.total === 0 ? 0 : (stats.blocked / stats.total) * 100;
    return (
      <div className="space-y-8">
        <Card className="gap-0 py-0">
          <CardContent className="space-y-6 p-5">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="flex flex-wrap gap-x-12 gap-y-4">
                <Figure label="Queries" value={stats.total} />
                <Figure label="Allowed" value={allowed} />
                <Figure label="Blocked" value={stats.blocked} />
                <div>
                  <div className="text-sm text-muted-foreground">Share blocked</div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
                    {share.toFixed(1)}%
                  </div>
                </div>
              </div>
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
            <QueryChart series={stats.series} />
          </CardContent>
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <TopDomains title="Top domains" rows={stats.topDomains} tone="neutral" />
          <TopDomains title="Top blocked domains" rows={stats.topBlocked} tone="blocked" />
        </div>
      </div>
    );
  })();

  return body;
}
