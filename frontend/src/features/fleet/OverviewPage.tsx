import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "@/api";
import { enrollmentKeys, enrollmentQueries } from "@/api/queries/enrollment";
import type { PendingAgentClaim } from "@/features/enrollment/PendingApprovalsCard";
import { AddAgentModal } from "@/features/enrollment/AddAgentModal";
import { PageActions } from "@/app/shell/AppShell";
import { FleetOverview } from "@/features/fleet/components/FleetOverview";
import { PendingApprovalsCard } from "@/features/enrollment/PendingApprovalsCard";
import { Button } from "@/components/ui/button";
import { useFleetPreferenceScope, useFleetPreferences } from "@/features/fleet/lib/fleetPreferences";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import { useAgents } from "@/app/providers/useAgents";
import { useSession } from "@/app/providers/useSession";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { useFleetActions } from "@/features/fleet/hooks/useFleetActions";

const NO_CLAIMS: PendingAgentClaim[] = [];

export function OverviewPage() {
  const navigate = useNavigate();
  const { user: currentUser } = useSession();
  const { agents, liveStatus, agentInfo, agentInfoReceivedAtMs, initialized, refresh } = useAgents();
  const fleetActions = useFleetActions();
  const loadingAgents = !initialized;
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === "admin";
  const claimsQuery = useQuery({ ...enrollmentQueries.claims(), enabled: isAdmin });
  const enrollClaims: PendingAgentClaim[] = claimsQuery.isError ? NO_CLAIMS : claimsQuery.data?.claims ?? NO_CLAIMS;
  const enrollClaimsLoading = claimsQuery.isFetching;
  const enrollClaimsLoadedAt = claimsQuery.dataUpdatedAt ? new Date(claimsQuery.dataUpdatedAt) : null;
  const preferenceScope = useFleetPreferenceScope();
  const [preferences, updatePreferences] = useFleetPreferences(preferenceScope);
  // Drop favorites for devices that no longer exist.
  useEffect(() => {
    if (!loadingAgents && preferences.favorites.some((id) => !agents[id])) {
      updatePreferences((previous) => ({ ...previous, favorites: previous.favorites.filter((id) => Boolean(agents[id])) }));
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

  const agentList = Object.values(agents);
  const totalAgents = agentList.length;
  const onlineAgents = agentList.filter((a) => a.online).length;

  usePageHeader({
    title: "Agents",
    description: totalAgents > 0 ? `${totalAgents} enrolled · ${onlineAgents} online` : "Every device reporting to this server.",
  });

  const openAgent = (agentId: string, tab: TabKey = "activity", scroll?: boolean) => {
    const q = scroll ? "&scroll=activity" : "";
    navigate(`/agents/${agentId}?tab=${tab}${q}`);
  };

  return (
    <>
      {isAdmin && (
        <PageActions>
          <Button onClick={() => setAddAgentOpen(true)}>
            <Plus /> Enroll agent
          </Button>
        </PageActions>
      )}
      {isAdmin && (
        <PendingApprovalsCard
          claims={enrollClaims}
          loading={enrollClaimsLoading}
          lastRefreshedAt={enrollClaimsLoadedAt}
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
        onSelectAgent={openAgent}
        onOpenScreen={(agentId) => navigate(`/agents/${agentId}?tab=live`)}
        onRefresh={refresh}
        onBatchWake={(ids) => void fleetActions.wake(ids)}
        onBulkScript={() => {}}
        onBulkAddToGroup={isAdmin ? () => {} : undefined}
        onBatchLock={fleetActions.lock}
        onBatchRestart={fleetActions.restart}
        onBatchShutdown={fleetActions.shutdown}
        canOperate={canOperate}
        onAddAgent={isAdmin ? () => setAddAgentOpen(true) : undefined}
        onDeleteAgents={isAdmin ? async (ids) => { await api.deleteAgents(ids); } : undefined}
      />
      <AddAgentModal visible={addAgentOpen} onDismiss={() => setAddAgentOpen(false)} />
    </>
  );
}
