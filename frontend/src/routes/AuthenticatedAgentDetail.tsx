import { AppShell } from "../components/fleet/AppShell";
import { AgentDetailPage } from "../pages/AgentDetailPage";
import type { Agent, AgentInfo, AgentLiveStatus, TabKey, DashboardNavUser, DashboardRole } from "../lib/types";
import type { NotificationItem } from "../hooks/useNotifications";

interface Props {
  agent: Agent;
  agents: Record<string, Agent>;
  agentInfo: AgentInfo | null;
  agentInfoById: Record<string, AgentInfo | null>;
  liveStatus?: AgentLiveStatus;
  liveStatusById: Record<string, AgentLiveStatus>;
  sendWsMessage: (msg: unknown) => void;
  onNotifyInfo: (header: string, content?: string) => void;
  onNotifyWarning: (header: string, content?: string) => void;
  onNotifyError: (header: string, content?: string) => void;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  onBackToOverview?: () => void;
  onSelectAgent: (agentId: string) => void;
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenActivityLog: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  onOpenAgentGroups?: () => void;
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
  /** Used to hide or explain tabs that require operator/admin on the server. */
  dashboardRole?: DashboardRole | null;
  dashboardAccountId?: string | null;
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
  /** ISO timestamp to scroll to and highlight in the activity timeline */
  highlightTimestamp?: string | null;
}

export function AuthenticatedAgentDetail({
  agent,
  agents,
  agentInfo,
  agentInfoById,
  liveStatus,
  liveStatusById,
  sendWsMessage,
  onNotifyInfo,
  onNotifyWarning,
  onNotifyError,
  activeTab,
  onTabChange,
  onBackToOverview,
  onSelectAgent,
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  onOpenAgentGroups,
  currentUser = null,
  dashboardRole = null,
  dashboardAccountId = null,
  notifications,
  onDismissNotification,
  highlightTimestamp,
}: Props) {
  return (
    <AppShell
      title="Agent Details"
      currentUser={currentUser}
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenUsers={onOpenUsers}
      onOpenActivityLog={onOpenActivityLog}
      onOpenNotifications={onOpenNotifications}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
      agents={Object.values(agents)}
      onSelectAgent={onSelectAgent}
      hideTopBar={true}
    >
      <AgentDetailPage
        agent={agent}
        agents={agents}
        agentInfo={agentInfo}
        agentInfoById={agentInfoById}
        liveStatus={liveStatus}
        liveStatusById={liveStatusById}
        sendWsMessage={sendWsMessage}
        onNotifyInfo={onNotifyInfo}
        onNotifyWarning={onNotifyWarning}
        onNotifyError={onNotifyError}
        activeTab={activeTab}
        onTabChange={onTabChange}
        onBackToOverview={onBackToOverview}
        onSelectAgent={onSelectAgent}
        highlightTimestamp={highlightTimestamp}
        isAdmin={currentUser?.role === "admin"}
        onOpenAgentGroups={onOpenAgentGroups}
        dashboardRole={dashboardRole}
        dashboardAccountId={dashboardAccountId}
      />
    </AppShell>
  );
}
