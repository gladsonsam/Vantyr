import { useState } from "react";
import { BarChart3, Globe2 } from "lucide-react";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { MetricRing } from "@/components/common/MetricRing";
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

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <KeyValueCard label={label} format="custom">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">
        <Counter value={value} fontSize={24} fontWeight={600} textColor="currentColor" />
      </div>
    </KeyValueCard>
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
        <DetailSection
          title="Queries"
          icon={BarChart3}
          action={
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
          }
        >
          <KeyValueGrid>
            <Figure label="Queries" value={stats.total} />
            <Figure label="Allowed" value={allowed} />
            <Figure label="Blocked" value={stats.blocked} />
            <KeyValueCard label="Share blocked" format="custom">
              <div className="flex items-center gap-3">
                <MetricRing percent={share} variant="cpu" size={40} stroke={5} />
                <span className="text-2xl font-semibold tabular-nums tracking-tight">
                  {share.toFixed(1)}%
                </span>
              </div>
            </KeyValueCard>
          </KeyValueGrid>
          <div className="rounded-xl border border-border/70 bg-card/10 p-5">
            <QueryChart series={stats.series} />
          </div>
        </DetailSection>
        <DetailSection title="Domains" icon={Globe2}>
          <div className="grid gap-4 lg:grid-cols-2">
            <TopDomains title="Top domains" rows={stats.topDomains} tone="neutral" />
            <TopDomains title="Top blocked domains" rows={stats.topBlocked} tone="blocked" />
          </div>
        </DetailSection>
      </div>
    );
  })();

  return body;
}
