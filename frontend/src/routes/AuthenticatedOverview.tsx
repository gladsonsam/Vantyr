import { useState, useEffect, useCallback } from "react";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import type { PendingAgentClaim } from "../components/fleet/PendingApprovalsCard";
import { AddAgentModal } from "../components/overview/AddAgentModal";
import { AppShell } from "../components/fleet/AppShell";
import { FleetOverview } from "../components/fleet/FleetOverview";
import { PendingApprovalsCard } from "../components/fleet/PendingApprovalsCard";
import { Button } from "../components/ui/button";
import { useFleetPreferenceScope, useFleetPreferences } from "../lib/fleetPreferences";
import type { Agent, AgentInfo, AgentLiveStatus, DashboardNavUser, TabKey } from "../lib/types";
import type { NotificationItem } from "../hooks/useNotifications";

interface Props {
  agents: Record<string, Agent>;
  liveStatus: Record<string, AgentLiveStatus>;
  agentInfo: Record<string, AgentInfo | null>;
  agentInfoReceivedAtMs: Record<string, number>;
  loadingAgents: boolean;
  onSelectAgent: (agentId: string, tab?: TabKey, scroll?: boolean) => void;
  onOpenScreen: (agentId: string) => void;
  onRefresh: () => void;
  onBatchWake: (agentIds: string[]) => void;
  onBatchLock: (agentIds: string[]) => void;
  onBatchRestart: (agentIds: string[]) => void;
  onBatchShutdown: (agentIds: string[]) => void;
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenActivityLog: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
}

export function AuthenticatedOverview({
  agents,
  liveStatus,
  agentInfo,
  agentInfoReceivedAtMs,
  loadingAgents,
  onSelectAgent,
  onOpenScreen,
  onRefresh,
  onBatchWake,
  onBatchLock,
  onBatchRestart,
  onBatchShutdown,
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  currentUser = null,
  notifications,
  onDismissNotification,
}: Props) {
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
    if (onRefresh) {
      onRefresh();
    }
  };

  const rejectEnrollmentClaim = async (claim: PendingAgentClaim) => {
    if (!isAdmin) return;
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadEnrollmentClaims();
  };

  const agentList = Object.values(agents);
  const totalAgents = agentList.length;
  const onlineAgents = agentList.filter((a) => a.online).length;

  return (
    <AppShell
      title="Agents"
      description={totalAgents > 0 ? `${totalAgents} enrolled · ${onlineAgents} online` : "Every device reporting to this server."}
      actions={
        isAdmin ? (
          <Button onClick={() => setAddAgentOpen(true)}>
            <Plus /> Enroll agent
          </Button>
        ) : undefined
      }
      currentUser={currentUser}
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenUsers={onOpenUsers}
      onOpenActivityLog={onOpenActivityLog}
      onOpenNotifications={onOpenNotifications}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
      agents={agentList}
      onSelectAgent={(agentId) => onSelectAgent(agentId)}
    >
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
        onSelectAgent={onSelectAgent}
        onOpenScreen={onOpenScreen}
        onRefresh={onRefresh}
        onBatchWake={onBatchWake}
        onBulkScript={() => {}}
        onBulkAddToGroup={isAdmin ? () => {} : undefined}
        onBatchLock={onBatchLock}
        onBatchRestart={onBatchRestart}
        onBatchShutdown={onBatchShutdown}
        canOperate={canOperate}
        onAddAgent={isAdmin ? () => setAddAgentOpen(true) : undefined}
        onDeleteAgents={isAdmin ? async (ids) => { await api.deleteAgents(ids); } : undefined}
      />
      <AddAgentModal visible={addAgentOpen} onDismiss={() => setAddAgentOpen(false)} />
    </AppShell>
  );
}
