import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Ban } from "lucide-react";
import { errorText } from "@/api";
import { networkQueries, toGatewayObservation, useGatewayMutations } from "@/api/queries/network";
import { EmptyState } from "@/components/common/EmptyState";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { GatewayCredentialsSection } from "./GatewayCredentialsSection";
import { GatewayDesiredSection } from "./GatewayDesiredSection";
import { GatewayReportsSection } from "./GatewayReportsSection";
import { gatewayLiveness } from "./gatewayStatusLib";
import { LivenessStatus } from "./gatewayStatus";
import { HoldAction } from "./HoldAction";
import { IssuedTokenDialog, type IssuedToken } from "./IssuedTokenDialog";

/** One gateway: desired versus reported policy, worker tokens and recent reports. */
export function GatewayDetailPage() {
  const { gatewayId = "" } = useParams();
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  const gateways = useQuery(networkQueries.gateways(household.id));
  const reports = useQuery(networkQueries.gatewayReports(household.id, gatewayId, { limit: 1 }));
  const desired = useQuery(networkQueries.gatewayDesired(household.id, gatewayId));
  const { revoke } = useGatewayMutations(household.id);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const back = (
    <Link
      to="/network/gateways"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ArrowLeft className="size-4" aria-hidden="true" /> Gateways
    </Link>
  );

  if (gateways.isPending) return <PageLoading />;
  if (gateways.isError) {
    return (
      <div className="space-y-6">
        {back}
        <QueryError
          title="Gateway"
          error={gateways.error}
          scope="network_admin"
          onRetry={() => void gateways.refetch()}
        />
      </div>
    );
  }
  const gateway = gateways.data.gateways.find((g) => g.id === gatewayId);
  if (!gateway) {
    return (
      <div className="space-y-6">
        {back}
        <EmptyState
          title="Gateway not found"
          description="It may belong to another household or no longer exist."
        />
      </div>
    );
  }
  const newest = reports.data?.reports[0];
  const observation = newest ? toGatewayObservation(newest) : null;

  const revokeGateway = async () => {
    setError(null);
    try {
      await revoke.mutateAsync(gateway.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="space-y-8">
      {back}
      <SettingsPageHeader
        title={gateway.label}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{gateway.kind === "dns" ? "DNS gateway" : "Proxy gateway"}</span>
            <LivenessStatus liveness={gatewayLiveness(gateway)} />
            <span>
              Last report <TimeAgo iso={gateway.last_seen_at} />
            </span>
          </span>
        }
        actions={
          isAdmin && !gateway.revoked_at ? (
            <HoldAction
              icon={<Ban className="size-4" />}
              ariaLabel={`Hold to revoke gateway ${gateway.label}`}
              doneLabel="Revoked"
              disabled={revoke.isPending}
              onHold={() => void revokeGateway()}
            >
              Hold to revoke gateway
            </HoldAction>
          ) : null
        }
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <GatewayDesiredSection
        household={household.id}
        gateway={gateway}
        desired={desired.data?.desired ?? null}
        observation={observation}
        isAdmin={isAdmin}
      />
      <GatewayCredentialsSection
        household={household.id}
        gateway={gateway}
        isAdmin={isAdmin}
        onIssued={setIssued}
      />
      <GatewayReportsSection household={household.id} gatewayId={gateway.id} />
      <IssuedTokenDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}
