import { DashboardLayout } from "../layouts/DashboardLayout";
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
  onOpenHelp: () => void;
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
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
  toolsOpen: boolean;
  onToolsChange: (open: boolean) => void;
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
  onOpenHelp,
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  onOpenAgentGroups,
  onGoHome,
  currentUser = null,
  dashboardRole = null,
  notifications,
  onDismissNotification,
  toolsOpen,
  onToolsChange,
  highlightTimestamp,
}: Props) {
  return (
    <DashboardLayout
      content={
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
          onOpenHelp={onOpenHelp}
          highlightTimestamp={highlightTimestamp}
          isAdmin={currentUser?.role === "admin"}
          onOpenAgentGroups={onOpenAgentGroups}
          dashboardRole={dashboardRole}
        />
      }
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenActivityLog={onOpenActivityLog}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onGoHome={onGoHome}
      contentType="default"
      currentUser={currentUser}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
      showTools={false}
      toolsOpen={toolsOpen}
      onToolsChange={onToolsChange}
      hideTopBar={true}
    />
  );
}
