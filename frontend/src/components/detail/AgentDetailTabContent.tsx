import type { TabKey, DashboardRole, Agent, AgentInfo } from "../../lib/types";
import type { Session } from "../../lib/session-aggregator";
import { SpecsTab } from "../tabs/SpecsTab";
import { KeysTab } from "../tabs/KeysTab";
import { WindowsTab } from "../tabs/WindowsTab";
import { UrlsTab } from "../tabs/UrlsTab";
import { EventsTab } from "../tabs/EventsTab";
import { FilesTab } from "../tabs/FilesTab";
import { AgentLogsTab } from "../tabs/AgentLogsTab";
import { AnalyticsTab } from "../tabs/AnalyticsTab";
import { SoftwareTab } from "../tabs/SoftwareTab";
import { ScriptsTab } from "../tabs/ScriptsTab";
import { AgentSettingsTab } from "../AgentSettingsTab";
import { ControlTab } from "../tabs/ControlTab";
import { TerminalTab } from "../tabs/TerminalTab";
import { ActivityTimeline } from "../timeline/ActivityTimeline";

export interface AgentDetailTabContentProps {
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
    case "specs":
      return <SpecsTab agentId={agent.id} cachedInfo={resolvedInfo} agentOnline={agent.online} />;
    case "software":
      return (
        <SoftwareTab agentId={agent.id} agentInfo={resolvedInfo} onNotifyInfo={onNotifyInfo} onNotifyError={onNotifyError} />
      );
    case "scripts":
      return <ScriptsTab agentId={agent.id} agentInfo={resolvedInfo} dashboardRole={dashboardRole} />;
    case "keys":
      return <KeysTab agentId={agent.id} agentInfo={resolvedInfo} />;
    case "windows":
      return <WindowsTab agentId={agent.id} agentInfo={resolvedInfo} />;
    case "urls":
      return <UrlsTab agentId={agent.id} agentInfo={resolvedInfo} />;
    case "analytics":
      return <AnalyticsTab agentId={agent.id} />;
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
      return <TerminalTab agentId={agent.id} agentOnline={agent.online} agentInfo={resolvedInfo} />;
    case "settings":
      return (
        <AgentSettingsTab
          agentId={agent.id}
          agentName={agent.name}
          agentOnline={agent.online}
          agentVersion={resolvedInfo?.agent_version ?? null}
          isAdmin={isAdmin}
          onOpenAgentGroups={onOpenAgentGroups}
        />
      );
    default:
      return null;
  }
}
