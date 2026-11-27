import { useState } from "react";
import { Server } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { networkKeys, useGatewayStatuses } from "@/api/queries/network";
import { EmptyState } from "@/components/common/EmptyState";
import { HelpTip } from "@/components/common/HelpTip";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { AddGatewayDialog } from "./AddGatewayDialog";
import { GatewayCard } from "./GatewayCard";
import { IssuedTokenDialog, type IssuedToken } from "./IssuedTokenDialog";

/** DNS and proxy workers, what an admin asked them to run, and what they say they applied. */
export function NetworkGatewaysPage() {
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  const { statuses, isPending, isError, error } = useGatewayStatuses(household.id);
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<IssuedToken | null>(null);

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title={
          <span className="flex items-center gap-2">
            Gateways
            <HelpTip label="About gateways">
              Gateways are workers that report in. Desired is what you asked for; reported applied
              is what the worker claims. Neither is verified enforcement. Worker tokens are not
              anyone’s proxy sign-in credential. Admins can rename a gateway, disable or re-enable
              it, or revoke it. A revoked gateway can’t be re-enabled.
            </HelpTip>
          </span>
        }
        description="Which workers are reporting, and what they say they applied."
        actions={
          isAdmin ? <AddGatewayDialog household={household.id} onIssued={setIssued} /> : null
        }
      />
      {isPending ? (
        <PageLoading />
      ) : isError ? (
        <QueryError
          title="Gateways"
          error={error}
          scope="network_admin"
          onRetry={() =>
            void queryClient.invalidateQueries({ queryKey: networkKeys.gatewaysRoot(household.id) })
          }
        />
      ) : statuses.length === 0 ? (
        <EmptyState
          title="No gateways yet"
          description={
            isAdmin
              ? "Add a DNS or proxy gateway to get its worker token."
              : "A network administrator can add a gateway."
          }
          icon={<Server className="size-5" />}
          iconVariant="icon"
        />
      ) : (
        <div className="space-y-6">
          {statuses.map((status) => (
            <GatewayCard key={status.gateway.id} status={status} />
          ))}
        </div>
      )}
      <IssuedTokenDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}
