import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "@/api";
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

export function OverviewPage() {
  const navigate = useNavigate();
  const { user: currentUser } = useSession();
  const { agents, liveStatus, agentInfo, agentInfoReceivedAtMs, initialized, refresh } = useAgents();
  const fleetActions = useFleetActions();
  const loadingAgents = !initialized;
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const [enrollClaims, setEnrollClaims] = useState<PendingAgentClaim[]>([]);
  const [enrollClaimsLoading, setEnrollClaimsLoading] = useState(false);
  const [enrollClaimsLoadedAt, setEnrollClaimsLoadedAt] = useState<Date | null>(null);

  const isAdmin = currentUser?.role === "admin";
  const preferenceScope = useFleetPreferenceScope();
  const [preferences, updatePreferences] = useFleetPreferences(preferenceScope);
  // Drop favorites for devices that no longer exist.
  useEffect(() => {
    if (!loadingAgents && preferences.favorites.some((id) => !agents[id])) {
      updatePreferences((previous) => ({ ...previous, favorites: previous.favorites.filter((id) => Boolean(agents[id])) }));
    }
  }, [agents, loadingAgents, preferences.favorites, updatePreferences]);
  const canOperate = currentUser?.role !== "viewer";

  const loadEnrollmentClaims = useCallback(async () => {
    if (!isAdmin) return;
    setEnrollClaimsLoading(true);
    try {
      const r = await api.listAgentEnrollmentClaims();
      setEnrollClaims(r.claims ?? []);
      setEnrollClaimsLoadedAt(new Date());
    } catch {
      setEnrollClaims([]);
    } finally {
      setEnrollClaimsLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (isAdmin) {
      void loadEnrollmentClaims();
    }
  }, [isAdmin, loadEnrollmentClaims]);

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
