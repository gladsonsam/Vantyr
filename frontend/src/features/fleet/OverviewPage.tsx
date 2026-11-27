import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "@/api";
import { enrollmentKeys, enrollmentQueries } from "@/api/queries/enrollment";
import type { PendingAgentClaim } from "@/features/enrollment/PendingApprovalsCard";
import { AddAgentModal } from "@/features/enrollment/AddAgentModal";
import { PageActions } from "@/app/shell/AppShell";
import { RefreshButton } from "@/components/common/RefreshButton";
import { FleetOverview } from "@/features/fleet/components/FleetOverview";
import { PendingApprovalsCard } from "@/features/enrollment/PendingApprovalsCard";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  useFleetPreferenceScope,
  useFleetPreferences,
} from "@/features/fleet/lib/fleetPreferences";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import { useAgents } from "@/app/providers/useAgents";
import { useSession } from "@/app/providers/useSession";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { useFleetActions } from "@/features/fleet/hooks/useFleetActions";
import { deviceHrefForAgent } from "@/features/devices/lib/agentHref";
import { useDeviceRows } from "@/features/devices/hooks/useDeviceRows";

const NO_CLAIMS: PendingAgentClaim[] = [];

export function OverviewPage() {
  const navigate = useNavigate();
  const { user: currentUser } = useSession();
  const { agents, liveStatus, agentInfo, agentInfoReceivedAtMs, initialized, refresh } =
    useAgents();
  const fleetActions = useFleetActions();
  const { rows: deviceRows } = useDeviceRows();
  // Devices that connect without an agent share the grid with the agent devices.
  const agentless = deviceRows.filter((row) => row.origin === "household" && row.agentId === null);
  const loadingAgents = !initialized;
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === "admin";
  const claimsQuery = useQuery({ ...enrollmentQueries.claims(), enabled: isAdmin });
  const enrollClaims: PendingAgentClaim[] = claimsQuery.isError
    ? NO_CLAIMS
    : (claimsQuery.data?.claims ?? NO_CLAIMS);
  const enrollClaimsLoading = claimsQuery.isFetching;
  const preferenceScope = useFleetPreferenceScope();
  const [preferences, updatePreferences] = useFleetPreferences(preferenceScope);
  // Drop favorites for devices that no longer exist.
  useEffect(() => {
    if (!loadingAgents && preferences.favorites.some((id) => !agents[id])) {
      updatePreferences((previous) => ({
        ...previous,
        favorites: previous.favorites.filter((id) => Boolean(agents[id])),
      }));
    }
  }, [agents, loadingAgents, preferences.favorites, updatePreferences]);
  const canOperate = currentUser?.role !== "viewer";

  const loadEnrollmentClaims = async () => {
    if (!isAdmin) return;
    await queryClient.invalidateQueries({ queryKey: enrollmentKeys.claims() });
  };

  const approveEnrollmentClaim = async (claim: PendingAgentClaim, agentName: string) => {
    if (!isAdmin) return;
    await api.approveAgentEnrollmentClaim(claim.id, { agent_name: agentName });
    await loadEnrollmentClaims();
    void refresh();
  };

  const rejectEnrollmentClaim = async (claim: PendingAgentClaim) => {
    if (!isAdmin) return;
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadEnrollmentClaims();
  };

  // The status tabs and the sidebar badge already carry the counts.
  usePageHeader({
    title: "Devices",
    description: "Every device and the ways it connects to Vantyr.",
  });

  // Opening a device shows its Overview; the quick actions open a tool in its Agent tab.
  const openAgent = (agentId: string, tab?: TabKey, scroll?: boolean) => {
    const href = tab
      ? deviceHrefForAgent(agentId, deviceRows, {
          search: `?tab=${tab}${scroll ? "&scroll=activity" : ""}`,
        })
      : deviceHrefForAgent(agentId, deviceRows);
    if (href) navigate(href);
  };

  return (
    <>
      <PageActions>
        {isAdmin && (
          <Button onClick={() => setAddAgentOpen(true)}>
            <Plus /> Enroll agent
          </Button>
        )}
        <RefreshButton
          label="Refresh devices"
          loading={refreshing}
          onClick={() => {
            setRefreshing(true);
            void refresh().finally(() => setRefreshing(false));
          }}
        />
      </PageActions>
      {isAdmin && claimsQuery.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn't check for devices waiting for approval.</span>
            <Button variant="outline" size="sm" onClick={() => void loadEnrollmentClaims()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {isAdmin && (
        <PendingApprovalsCard
          claims={enrollClaims}
          loading={enrollClaimsLoading}
          onRefresh={loadEnrollmentClaims}
          onApprove={approveEnrollmentClaim}
          onReject={rejectEnrollmentClaim}
        />
      )}
      <FleetOverview
        preferenceScope={preferenceScope}
        agents={agents}
        liveStatus={liveStatus}
        agentInfo={agentInfo}
        agentInfoReceivedAtMs={agentInfoReceivedAtMs}
        loadingAgents={loadingAgents}
        otherDevices={agentless}
        onSelectAgent={openAgent}
        onOpenScreen={(agentId) => openAgent(agentId, "live")}
        onRefresh={refresh}
        onBatchWake={(ids) => void fleetActions.wake(ids)}
        onBulkScript={() => {}}
        onBulkAddToGroup={isAdmin ? () => {} : undefined}
        onBatchLock={fleetActions.lock}
        onBatchRestart={fleetActions.restart}
        onBatchShutdown={fleetActions.shutdown}
        canOperate={canOperate}
        onAddAgent={isAdmin ? () => setAddAgentOpen(true) : undefined}
        onDeleteAgents={
          isAdmin
            ? async (ids) => {
                await api.deleteAgents(ids);
              }
            : undefined
        }
      />
      <AddAgentModal visible={addAgentOpen} onDismiss={() => setAddAgentOpen(false)} />
    </>
  );
}
