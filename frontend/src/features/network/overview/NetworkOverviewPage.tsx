import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useOverviewQuery } from "@/features/network/runtime/useRuntimeQueries";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { CoverageLimits } from "./CoverageLimits";
import { GatewayCard } from "./GatewayCard";
import { RevisionSummary } from "./RevisionSummary";

/** Gateways, what they have applied, and what they can honestly claim. */
export function NetworkOverviewPage() {
  const query = useOverviewQuery();

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (query.isError) {
    return (
      <LoadFailedCard
        message="Couldn’t load the network overview."
        onRetry={() => void query.refetch()}
      />
    );
  }
  const overview = query.data;
  if (overview.state === "unavailable") {
    return <UnavailableSection title="Gateways" reason={overview.reason} />;
  }

  const { revisions, gateways } = overview.data;
  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Overview"
        description="Which gateways are reporting, what they have applied, and what they can claim."
      />
      <RevisionSummary revisions={revisions} />
      <div className="space-y-8">
        {gateways.map((gateway) => (
          <GatewayCard key={gateway.id} gateway={gateway} />
        ))}
      </div>
      <CoverageLimits />
    </div>
  );
}
