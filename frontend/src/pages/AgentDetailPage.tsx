import { useState, useCallback } from "react";
import ContentLayout from "@cloudscape-design/components/content-layout";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Tabs from "@cloudscape-design/components/tabs";
import BreadcrumbGroup from "@cloudscape-design/components/breadcrumb-group";
import Modal from "@cloudscape-design/components/modal";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import {
  AGENT_DATA_SUBTABS,
  AGENT_LIVE_SUBTABS,
  AGENT_SECTION_ORDER,
  AGENT_SYSTEM_SUBTABS,
  agentSectionFromTabKey,
  agentTabBreadcrumbLabel,
  defaultTabForAgentSection,
  AGENT_TAB_META,
  type AgentSectionId,
} from "../lib/agentTabNav";
import { AgentSectionTabLabel } from "../lib/agentTabNavLabel";
import type { TabKey, DashboardRole } from "../lib/types";
import { api } from "../lib/api";
import type { Agent, AgentInfo, AgentLiveStatus } from "../lib/types";
import { PageHeader, type AgentAction } from "../components/detail/PageHeader";
import { GeneralConfig } from "../components/detail/GeneralConfig";
import { AgentDetailTabContent } from "../components/detail/AgentDetailTabContent";
import { useAgentActivitySessions } from "../hooks/useAgentActivitySessions";
import { useAgentInferredIdle } from "../hooks/useAgentInferredIdle";
import { useResolvedAgentInfo } from "../hooks/useResolvedAgentInfo";

interface AgentDetailPageProps {
  agent: Agent;
  agentInfo: AgentInfo | null;
  liveStatus?: AgentLiveStatus;
  sendWsMessage: (msg: unknown) => void;
  onNotifyInfo: (header: string, content?: string) => void;
  onNotifyWarning: (header: string, content?: string) => void;
  onNotifyError: (header: string, content?: string) => void;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  onBackToOverview?: () => void;
  onOpenHelp: () => void;
  /** ISO timestamp to scroll to + highlight in the activity timeline */
  highlightTimestamp?: string | null;
  isAdmin?: boolean;
  onOpenAgentGroups?: () => void;
  /** Current dashboard role; used to explain screen/script permission limits. */
  dashboardRole?: DashboardRole | null;
  /** Merge refreshed agent info into local UI and the global agent cache (overview, WS parity). */
  onAgentInfoCommit?: (agentId: string, info: AgentInfo | null) => void;
}

interface AgentTabContentProps {
  tab: TabKey;
  agent: Agent;
  dashboardRole?: DashboardRole | null | undefined;
  sendWsMessage: (msg: unknown) => void;
  onNotifyInfo: (header: string, content?: string) => void;
  onNotifyError: (header: string, content?: string) => void;
  isAdmin: boolean;
  onOpenAgentGroups?: () => void;
  resolvedInfo: AgentInfo | null;
  sessions: ReturnType<typeof useAgentActivitySessions>["sessions"];
  activityLoading: boolean;
  activityLoadingMore: boolean;
  activityHasMoreOlder: boolean;
  onLoadMoreActivity: ReturnType<typeof useAgentActivitySessions>["loadMoreOlderActivity"];
  onRefreshActivity: ReturnType<typeof useAgentActivitySessions>["loadActivityData"];
  highlightTimestamp: string | null;
  onViewTimelineFromAlerts: (timestamp: string) => void;
}

function AgentTabContent({
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
  activityLoadingMore,
  activityHasMoreOlder,
  onLoadMoreActivity,
  onRefreshActivity,
  highlightTimestamp,
  onViewTimelineFromAlerts,
}: AgentTabContentProps) {
  return (
    <AgentDetailTabContent
      tab={tab}
      agent={agent}
      dashboardRole={dashboardRole ?? null}
      sendWsMessage={sendWsMessage}
      onNotifyInfo={onNotifyInfo}
      onNotifyError={onNotifyError}
      isAdmin={isAdmin}
      onOpenAgentGroups={onOpenAgentGroups}
      resolvedInfo={resolvedInfo}
      sessions={sessions}
      activityLoading={activityLoading}
      activityLoadingMore={activityLoadingMore}
      activityHasMoreOlder={activityHasMoreOlder}
      onLoadMoreActivity={onLoadMoreActivity}
      onRefreshActivity={onRefreshActivity}
      highlightTimestamp={highlightTimestamp}
      onViewTimelineFromAlerts={onViewTimelineFromAlerts}
    />
  );
}

export function AgentDetailPage({
  agent,
  agentInfo,
  liveStatus,
  sendWsMessage,
  onNotifyInfo,
  onNotifyWarning,
  onNotifyError,
  activeTab,
  onTabChange,
  onBackToOverview,
  highlightTimestamp,
  onOpenHelp,
  isAdmin = false,
  onOpenAgentGroups,
  dashboardRole = null,
  onAgentInfoCommit,
}: AgentDetailPageProps) {
  /** Timestamp set when user clicks "View in Timeline" from the Alerts tab (overrides URL param) */
  const [timelineHighlight, setTimelineHighlight] = useState<string | null>(null);
  const { resolvedInfo, setResolvedInfo } = useResolvedAgentInfo(agent.id, agentInfo);
  const inferredIdleSeconds = useAgentInferredIdle(agent.id, liveStatus?.activity);
  const {
    sessions,
    loading,
    loadingMore,
    hasMoreOlder,
    loadMoreOlderActivity,
    loadActivityData,
  } = useAgentActivitySessions(agent.id, activeTab);
  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<AgentAction | null>(null);
  const [infoRequestedAtMs, setInfoRequestedAtMs] = useState<number | null>(null);
  const infoUpdatedTsSecs = typeof resolvedInfo?.ts === "number" && Number.isFinite(resolvedInfo.ts)
    ? resolvedInfo.ts
    : null;

  // Merge prop-based highlightTimestamp (from URL ?at=) with local state
  const effectiveHighlightTimestamp = timelineHighlight ?? highlightTimestamp;

  const runAgentAction = useCallback(
    (action: AgentAction) => {
      if (action === "wake-lan") {
        if (agent.online) {
          onNotifyInfo("Agent already online", `${agent.name} is connected — Wake on LAN is usually only needed while offline.`);
          return;
        }
        setPendingAction("wake-lan");
        void api
          .wakeAgent(agent.id)
          .then((r) =>
            onNotifyInfo(
              "Wake on LAN sent",
              `Magic packet sent to ${r.mac} (${r.broadcast}:${r.port}). WoL must be enabled on the PC; the server must reach the subnet broadcast.`,
            ),
          )
          .catch((e) => onNotifyError("Wake on LAN failed", String(e)))
          .finally(() => setPendingAction(null));
        return;
      }

      if (!agent.online) {
        onNotifyWarning("Agent offline", `Cannot run "${action}" while ${agent.name} is offline.`);
        return;
      }

      if (action === "request-info") {
        setPendingAction("request-info");
        setInfoRequestedAtMs(Date.now());
        sendWsMessage({
          type: "control",
          agent_id: agent.id,
          cmd: { type: "RequestInfo" },
        });
        // Keep this quiet; the page header shows inline "Requested…" feedback.
        setTimeout(() => setPendingAction((prev) => (prev === "request-info" ? null : prev)), 800);
        return;
      }

      if (action === "lock-host") {
        setPendingAction("lock-host");
        sendWsMessage({
          type: "control",
          agent_id: agent.id,
          cmd: { type: "LockHost" },
        });
        onNotifyWarning("Lock sent", `Sent lock command to ${agent.name}.`);
        setTimeout(() => setPendingAction((prev) => (prev === "lock-host" ? null : prev)), 800);
        return;
      }

      if (action === "restart-host") {
        setConfirmAction("restart-host");
        return;
      }

      if (action === "shutdown-host") {
        setConfirmAction("shutdown-host");
        return;
      }

      onNotifyError("Unsupported action", `Action "${action}" is not implemented.`);
    },
    [agent.id, agent.name, agent.online, sendWsMessage, onNotifyInfo, onNotifyWarning, onNotifyError]
  );

  const confirmAndRun = useCallback(() => {
    const action = confirmAction;
    if (!action) return;
    setConfirmAction(null);

    if (!agent.online) {
      onNotifyWarning("Agent offline", `Cannot run "${action}" while ${agent.name} is offline.`);
      return;
    }

    if (action === "restart-host") {
      setPendingAction("restart-host");
      sendWsMessage({
        type: "control",
        agent_id: agent.id,
        cmd: { type: "RestartHost" },
      });
      onNotifyWarning("Restart sent", `Sent restart command to ${agent.name}.`);
      setTimeout(() => setPendingAction((prev) => (prev === "restart-host" ? null : prev)), 800);
      return;
    }

    if (action === "shutdown-host") {
      setPendingAction("shutdown-host");
      sendWsMessage({
        type: "control",
        agent_id: agent.id,
        cmd: { type: "ShutdownHost" },
      });
      onNotifyWarning("Shutdown sent", `Sent shutdown command to ${agent.name}.`);
      setTimeout(() => setPendingAction((prev) => (prev === "shutdown-host" ? null : prev)), 800);
      return;
    }
  }, [agent.id, agent.name, agent.online, confirmAction, onNotifyWarning, sendWsMessage]);

  const activeSection = agentSectionFromTabKey(activeTab);

  const mainTabs = AGENT_SECTION_ORDER.map((section) => {
    const content =
      activeSection === section
        ? (() => {
            if (section === "live") {
              return (
                <SpaceBetween size="l">
                  <SegmentedControl
                    label="View"
                    selectedId={activeTab}
                    options={AGENT_LIVE_SUBTABS.map((id) => ({
                      id,
                      text: id === "live" ? "Screen" : "Activity",
                    }))}
                    onChange={({ detail }) => onTabChange(detail.selectedId as TabKey)}
                  />
                  <AgentTabContent
                    tab={activeTab}
                    agent={agent}
                    dashboardRole={dashboardRole}
                    sendWsMessage={sendWsMessage}
                    onNotifyInfo={onNotifyInfo}
                    onNotifyError={onNotifyError}
                    isAdmin={isAdmin}
                    onOpenAgentGroups={onOpenAgentGroups}
                    resolvedInfo={resolvedInfo}
                    sessions={sessions}
                    activityLoading={loading}
                    activityLoadingMore={loadingMore}
                    activityHasMoreOlder={hasMoreOlder}
                    onLoadMoreActivity={loadMoreOlderActivity}
                    onRefreshActivity={loadActivityData}
                    highlightTimestamp={effectiveHighlightTimestamp ?? null}
                    onViewTimelineFromAlerts={(timestamp) => {
                      setTimelineHighlight(timestamp);
                      onTabChange("activity");
                    }}
                  />
                </SpaceBetween>
              );
            }
            if (section === "system") {
              return (
                <SpaceBetween size="l">
                  <SegmentedControl
                    label="System view"
                    selectedId={activeTab}
                    options={AGENT_SYSTEM_SUBTABS.map((id) => ({
                      id,
                      text: AGENT_TAB_META[id].tabLabel,
                    }))}
                    onChange={({ detail }) => onTabChange(detail.selectedId as TabKey)}
                  />
                  <AgentTabContent
                    tab={activeTab}
                    agent={agent}
                    dashboardRole={dashboardRole}
                    sendWsMessage={sendWsMessage}
                    onNotifyInfo={onNotifyInfo}
                    onNotifyError={onNotifyError}
                    isAdmin={isAdmin}
                    onOpenAgentGroups={onOpenAgentGroups}
                    resolvedInfo={resolvedInfo}
                    sessions={sessions}
                    activityLoading={loading}
                    activityLoadingMore={loadingMore}
                    activityHasMoreOlder={hasMoreOlder}
                    onLoadMoreActivity={loadMoreOlderActivity}
                    onRefreshActivity={loadActivityData}
                    highlightTimestamp={effectiveHighlightTimestamp ?? null}
                    onViewTimelineFromAlerts={(timestamp) => {
                      setTimelineHighlight(timestamp);
                      onTabChange("activity");
                    }}
                  />
                </SpaceBetween>
              );
            }
            if (section === "data") {
              return (
                <SpaceBetween size="l">
                  <SegmentedControl
                    label="Recorded data"
                    selectedId={activeTab}
                    options={AGENT_DATA_SUBTABS.map((id) => ({
                      id,
                      text: AGENT_TAB_META[id].tabLabel,
                    }))}
                    onChange={({ detail }) => onTabChange(detail.selectedId as TabKey)}
                  />
                  <AgentTabContent
                    tab={activeTab}
                    agent={agent}
                    dashboardRole={dashboardRole}
                    sendWsMessage={sendWsMessage}
                    onNotifyInfo={onNotifyInfo}
                    onNotifyError={onNotifyError}
                    isAdmin={isAdmin}
                    onOpenAgentGroups={onOpenAgentGroups}
                    resolvedInfo={resolvedInfo}
                    sessions={sessions}
                    activityLoading={loading}
                    activityLoadingMore={loadingMore}
                    activityHasMoreOlder={hasMoreOlder}
                    onLoadMoreActivity={loadMoreOlderActivity}
                    onRefreshActivity={loadActivityData}
                    highlightTimestamp={effectiveHighlightTimestamp ?? null}
                    onViewTimelineFromAlerts={(timestamp) => {
                      setTimelineHighlight(timestamp);
                      onTabChange("activity");
                    }}
                  />
                </SpaceBetween>
              );
            }
            return (
              <AgentTabContent
                tab={activeTab}
                agent={agent}
                dashboardRole={dashboardRole}
                sendWsMessage={sendWsMessage}
                onNotifyInfo={onNotifyInfo}
                onNotifyError={onNotifyError}
                isAdmin={isAdmin}
                onOpenAgentGroups={onOpenAgentGroups}
                resolvedInfo={resolvedInfo}
                sessions={sessions}
                activityLoading={loading}
                activityLoadingMore={loadingMore}
                activityHasMoreOlder={hasMoreOlder}
                onLoadMoreActivity={loadMoreOlderActivity}
                onRefreshActivity={loadActivityData}
                highlightTimestamp={effectiveHighlightTimestamp ?? null}
                onViewTimelineFromAlerts={(timestamp) => {
                  setTimelineHighlight(timestamp);
                  onTabChange("activity");
                }}
              />
            );
          })()
        : null;

    return {
      id: section,
      label: <AgentSectionTabLabel section={section} />,
      content,
      contentRenderStrategy: "active" as const,
    };
  });

  const breadcrumbTabLabel = agentTabBreadcrumbLabel(activeTab);

  return (
    <ContentLayout>
      <SpaceBetween size="l">
        <BreadcrumbGroup
          items={[
            { text: "Agents", href: "#overview" },
            { text: agent.name, href: `#agent/${agent.id}` },
            { text: breadcrumbTabLabel, href: `#${activeTab}` },
          ]}
          onFollow={(event) => {
            event.preventDefault();
            const href = event.detail.href;
            if (href === "#overview" && onBackToOverview) {
              onBackToOverview();
            }
          }}
        />

        <PageHeader
          agent={agent}
          liveStatus={liveStatus}
          inferredIdleSeconds={inferredIdleSeconds}
          infoHostname={resolvedInfo?.hostname ?? null}
          infoRequestedAtMs={infoRequestedAtMs}
          infoUpdatedTsSecs={infoUpdatedTsSecs}
          onOpenHelp={onOpenHelp}
          onRunAction={runAgentAction}
          pendingAction={pendingAction}
        />

        <Modal
          visible={confirmAction === "restart-host" || confirmAction === "shutdown-host"}
          onDismiss={() => setConfirmAction(null)}
          header={confirmAction === "restart-host" ? "Confirm restart" : "Confirm shutdown"}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setConfirmAction(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={pendingAction === "restart-host" || pendingAction === "shutdown-host"}
                  onClick={confirmAndRun}
                >
                  {confirmAction === "restart-host" ? "Restart" : "Shutdown"}
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="s">
            <Box>
              {confirmAction === "restart-host"
                ? `Restart "${agent.name}" now? Any unsaved work may be lost.`
                : `Shutdown "${agent.name}" now? You may need Wake on LAN to bring it back.`}
            </Box>
          </SpaceBetween>
        </Modal>

        <GeneralConfig
          agent={agent}
          info={resolvedInfo}
          onAgentInfoRefreshed={(next) => {
            setResolvedInfo(next);
            onAgentInfoCommit?.(agent.id, next);
          }}
        />

        <Tabs
          ariaLabel="Agent views"
          activeTabId={activeSection}
          tabs={mainTabs}
          onChange={({ detail }) => {
            const nextSection = detail.activeTabId as AgentSectionId;
            if (agentSectionFromTabKey(activeTab) === nextSection) return;
            onTabChange(defaultTabForAgentSection(nextSection));
          }}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
