import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useOverviewQuery } from "@/features/network/runtime/useRuntimeQueries";
import { CoverageLimits } from "./CoverageLimits";
import { GatewayCard } from "./GatewayCard";
import { RevisionSummary } from "./RevisionSummary";

/** Gateways, what they have applied, and what they can honestly claim. */
export function NetworkOverviewPage() {
  const query = useOverviewQuery();

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
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
    <div className="space-y-6">
      <RevisionSummary revisions={revisions} />
      <div className="grid gap-4 lg:grid-cols-2">
        {gateways.map((gateway) => (
          <GatewayCard key={gateway.id} gateway={gateway} />
        ))}
      </div>
      <CoverageLimits />
    </div>
  );
}
