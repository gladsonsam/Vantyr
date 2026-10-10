import type { DashboardRole, Agent, AgentInfo } from "@/api/types";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import type { Session } from "@/features/activity/sessionAggregator";
import { SpecsTab } from "@/features/agent-detail/tabs/SpecsTab";
import { KeysTab } from "@/features/agent-detail/tabs/KeysTab";
import { WindowsTab } from "@/features/agent-detail/tabs/WindowsTab";
import { UrlsTab } from "@/features/agent-detail/tabs/UrlsTab";
import { EventsTab } from "@/features/activity/EventsTab";
import { FilesTab } from "@/features/files/FilesTab";
import { AgentLogsTab } from "@/features/agent-detail/tabs/AgentLogsTab";
import { AnalyticsTab } from "@/features/agent-detail/tabs/AnalyticsTab";
import { SoftwareTab } from "@/features/agent-detail/tabs/SoftwareTab";
import { ScriptsTab } from "@/features/agent-detail/tabs/ScriptsTab";
import { AgentSettingsTab } from "@/features/agent-settings/AgentSettingsTab";
import { ControlTab } from "@/features/remote/components/ControlTab";
import { TerminalTab } from "@/features/remote/components/TerminalTab";
import { ActivityTimeline } from "@/features/activity/ActivityTimeline";
import { RecallDayPanel } from "@/features/recall/components/RecallDayPanel";
import { RecallView } from "@/features/recall/components/RecallView";

interface AgentDetailTabContentProps {
  tab: TabKey;
  agent: Agent;
  dashboardRole: DashboardRole | null;
  sendWsMessage: (msg: unknown) => void;
  onNotifyInfo: (header: string, content?: string) => void;
  onNotifyError: (header: string, content?: string) => void;
  isAdmin: boolean;
  onOpenAgentGroups?: () => void;
  resolvedInfo: AgentInfo | null;
  sessions: Session[];
  activityLoading: boolean;
  activityLoadingMore?: boolean;
  activityHasMoreOlder?: boolean;
  onLoadMoreActivity?: () => void;
  onRefreshActivity: () => void;
  highlightTimestamp: string | null;
  onViewTimelineFromAlerts: (timestamp: string) => void;
}

export function AgentDetailTabContent({
  tab,
  agent,
  dashboardRole,
  sendWsMessage,
  onNotifyInfo,
  onNotifyError,
  isAdmin,
  onOpenAgentGroups,
  resolvedInfo,
  sessions,
  activityLoading,
  activityLoadingMore = false,
  activityHasMoreOlder = false,
  onLoadMoreActivity,
  onRefreshActivity,
  highlightTimestamp,
  onViewTimelineFromAlerts,
}: AgentDetailTabContentProps) {
  switch (tab) {
    case "activity":
      return (
        <ActivityTimeline
          agentId={agent.id}
          sessions={sessions}
          loading={activityLoading}
          onRefresh={onRefreshActivity}
          onLoadMore={onLoadMoreActivity}
          hasMoreOlder={activityHasMoreOlder}
          loadingMore={activityLoadingMore}
          highlightTimestamp={highlightTimestamp}
        />
      );
    case "recall":
      // Same view as the standalone page, scoped to this agent — no device picker,
      // and `?at=` (already the timeline's highlight param) opens on that instant.
      return (
        <RecallView agentId={agent.id} initialAtIso={highlightTimestamp}>
          {(ctx) => <RecallDayPanel {...ctx} />}
        </RecallView>
      );
    case "specs":
      return <SpecsTab agentId={agent.id} cachedInfo={resolvedInfo} agentOnline={agent.online} />;
    case "software":
      return (
        <SoftwareTab agentId={agent.id} agentInfo={resolvedInfo} dashboardRole={dashboardRole} onNotifyInfo={onNotifyInfo} onNotifyError={onNotifyError} />
      );
    case "scripts":
      return <ScriptsTab agentId={agent.id} agentInfo={resolvedInfo} dashboardRole={dashboardRole} />;
    case "keys":
      return <KeysTab agentId={agent.id} agentInfo={resolvedInfo} />;
    case "windows":
      return <WindowsTab agentId={agent.id} agentInfo={resolvedInfo} />;
    case "urls":
      return <UrlsTab agentId={agent.id} agentInfo={resolvedInfo} dashboardRole={dashboardRole} />;
    case "analytics":
      return <AnalyticsTab agentId={agent.id} dashboardRole={dashboardRole} />;
    case "alerts":
      return (
        <EventsTab agentId={agent.id} onViewTimeline={onViewTimelineFromAlerts} />
      );
    case "files":
      return <FilesTab agentId={agent.id} sendWsMessage={sendWsMessage} dashboardRole={dashboardRole} />;
    case "logs":
      return <AgentLogsTab agentId={agent.id} />;
    case "control":
      return (
        <ControlTab
          agentId={agent.id}
          agentName={agent.name}
          agentOnline={agent.online}
          isAdmin={isAdmin}
          agentInfo={resolvedInfo}
          sendWsMessage={sendWsMessage}
        />
      );
    case "terminal":
      return <TerminalTab agentId={agent.id} agentOnline={agent.online} agentInfo={resolvedInfo} dashboardRole={dashboardRole} />;
    case "settings":
      return (
        <AgentSettingsTab
          agentId={agent.id}
          agentName={agent.name}
          agentOnline={agent.online}
          agentVersion={resolvedInfo?.agent_version ?? null}
          isAdmin={isAdmin}
          dashboardRole={dashboardRole}
          onOpenAgentGroups={onOpenAgentGroups}
        />
      );
    default:
      return null;
  }
}
