import { notifyAgentRemoved } from "@/api/agentEvents";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { Agent, AgentInfo, AgentLiveStatus, DashboardRole } from "@/api/types";
import { AGENT_TAB_META, type TabKey } from "@/features/agent-detail/lib/agentTabNav";
import { api } from "@/api";
import { AgentDetailTabContent } from "@/features/agent-detail/components/AgentDetailTabContent";
import { AgentSectionNav } from "@/features/agent-detail/components/AgentSectionNav";
import { AgentDetailHeader } from "@/features/agent-detail/components/AgentDetailHeader";
import { AgentVitals } from "@/features/agent-detail/components/AgentVitals";
import { ScreenTab } from "@/features/remote/components/ScreenTab";
import { useDeviceModuleGrants } from "@/features/agent-settings/useDeviceModuleGrants";
import { useAgentActivitySessions } from "@/features/activity/useAgentActivitySessions";
import { useResolvedAgentInfo } from "./useResolvedAgentInfo";
import { useToolLanding } from "./useToolLanding";
import { useMobileNavOpener } from "@/app/shell/useMobileNavOpener";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import {
  agentVersion,
  formatLastSeen,
  formatUptime,
  statusFor,
  statusTone,
  type AgentAction,
} from "@/features/agent-detail/lib/agentStatus";

interface AgentDetailPageProps {
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
  highlightTimestamp?: string | null;
  isAdmin?: boolean;
  onOpenAgentGroups?: () => void;
  dashboardRole?: DashboardRole | null;
  dashboardAccountId?: string | null;
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
  isAdmin = false,
  onOpenAgentGroups,
  dashboardRole = null,
  dashboardAccountId = null,
}: AgentDetailPageProps) {
  const [timelineHighlight, setTimelineHighlight] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<AgentAction | null>(null);
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { resolvedInfo } = useResolvedAgentInfo(agent.id, agentInfo);
  const openMobileNav = useMobileNavOpener();
  const { sessions, loading, loadingMore, hasMoreOlder, loadMoreOlderActivity, loadActivityData } =
    useAgentActivitySessions(agent.id, activeTab);

  const [searchParams] = useSearchParams();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // The browser tab and history list name the agent and the tool, not just "Vantyr".
  const toolLabel = AGENT_TAB_META[activeTab].label;
  useEffect(() => {
    const previous = document.title;
    document.title = `${toolLabel} · ${agent.name} · Vantyr`;
    return () => {
      document.title = previous;
    };
  }, [agent.name, toolLabel]);

  // Every way of reaching a tool (click, address, reload, back/forward, palette) lands on it.
  const landOnPick = useToolLanding({
    rootRef: scrollContainerRef,
    agentId: agent.id,
    activeTab,
    scrollRequested: searchParams.get("scroll") === "activity",
    hasMoment: Boolean(highlightTimestamp),
  });
  const goToTool = useCallback(
    (tab: TabKey) => landOnPick(tab, onTabChange),
    [landOnPick, onTabChange],
  );

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const effectiveHighlightTimestamp = timelineHighlight ?? highlightTimestamp ?? null;
  const currentStatus = statusFor(agent, liveStatus);
  const tone = statusTone(currentStatus.status);
  const infoUpdatedTsSecs =
    typeof resolvedInfo?.ts === "number" && Number.isFinite(resolvedInfo.ts)
      ? resolvedInfo.ts
      : null;
  const uptimeSecs = useMemo(() => {
    if (resolvedInfo?.uptime_secs == null) return undefined;
    if (!agent.online) return resolvedInfo.uptime_secs;
    const receivedAt = infoUpdatedTsSecs ? infoUpdatedTsSecs * 1000 : 0;
    if (!receivedAt) return resolvedInfo.uptime_secs;
    return resolvedInfo.uptime_secs + Math.max(0, Math.floor((nowMs - receivedAt) / 1000));
  }, [agent.online, infoUpdatedTsSecs, nowMs, resolvedInfo?.uptime_secs]);

  const runAgentAction = useCallback(
    (action: AgentAction) => {
      // Backend: wake + all WS control commands are operator+ only.
      if (dashboardRole === "viewer") {
        onNotifyError("Not permitted", "Operators only.");
        return;
      }
      if (action === "wake-lan") {
        if (agent.online) {
          onNotifyInfo("Already online", "No need to wake it.");
          return;
        }
        setPendingAction("wake-lan");
        void api
          .wakeAgent(agent.id)
          .then((result) =>
            onNotifyInfo(
              "Wake on LAN sent",
              `Magic packet sent to ${result.mac} (${result.broadcast}:${result.port}).`,
            ),
          )
          .catch((error) => onNotifyError("Wake on LAN failed", String(error)))
          .finally(() => setPendingAction(null));
        return;
      }

      if (!agent.online) {
        onNotifyWarning("Agent offline", `Can't run "${action}".`);
        return;
      }

      if (action === "request-info") {
        setPendingAction("request-info");
        sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "RequestInfo" } });
        setTimeout(() => setPendingAction((prev) => (prev === "request-info" ? null : prev)), 800);
        return;
      }

      if (action === "lock-host") {
        setPendingAction("lock-host");
        sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "LockHost" } });
        onNotifyWarning("Lock sent", agent.name);
        setTimeout(() => setPendingAction((prev) => (prev === "lock-host" ? null : prev)), 800);
        return;
      }

      if (action === "restart-host" || action === "shutdown-host") {
        setConfirmAction(action);
      }
    },
    [
      agent.id,
      agent.name,
      agent.online,
      dashboardRole,
      onNotifyError,
      onNotifyInfo,
      onNotifyWarning,
      sendWsMessage,
    ],
  );

  const confirmAndRun = useCallback(() => {
    const action = confirmAction;
    if (!action) return;
    if (dashboardRole === "viewer") {
      onNotifyError("Not permitted", "Operators only.");
      setConfirmAction(null);
      return;
    }
    setConfirmAction(null);

    if (!agent.online) {
      onNotifyWarning("Agent offline", `Can't run "${action}".`);
      return;
    }

    if (action === "restart-host") {
      setPendingAction("restart-host");
      sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "RestartHost" } });
      onNotifyWarning("Restart sent", agent.name);
      setTimeout(() => setPendingAction((prev) => (prev === "restart-host" ? null : prev)), 800);
      return;
    }

    setPendingAction("shutdown-host");
    sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "ShutdownHost" } });
    onNotifyWarning("Shutdown sent", agent.name);
    setTimeout(() => setPendingAction((prev) => (prev === "shutdown-host" ? null : prev)), 800);
  }, [
    agent.id,
    agent.name,
    agent.online,
    confirmAction,
    dashboardRole,
    onNotifyError,
    onNotifyWarning,
    sendWsMessage,
  ]);

  const deleteThisAgent = useCallback(() => {
    setDeletingAgent(true);
    void api
      .deleteAgents([agent.id])
      .then(() => {
        notifyAgentRemoved(agent.id);
        setConfirmDeleteAgent(false);
        onNotifyInfo("Agent deleted", agent.name);
        onBackToOverview?.();
      })
      .catch((e: unknown) => {
        onNotifyError("Delete failed", String((e as { message?: string })?.message ?? e));
      })
      .finally(() => setDeletingAgent(false));
  }, [agent.id, agent.name, onBackToOverview, onNotifyError, onNotifyInfo]);

  // "live" is now the always-on top panel, not a tab — fall back to activity content.
  const shownTab: TabKey = activeTab === "live" ? "activity" : activeTab;
  const tabContent = (
    <AgentDetailTabContent
      tab={shownTab}
      agent={agent}
      dashboardRole={dashboardRole}
      sendWsMessage={sendWsMessage}
      onNotifyInfo={onNotifyInfo}
      onNotifyError={onNotifyError}
      isAdmin={isAdmin}
      onOpenAgentGroups={onOpenAgentGroups}
      onDeleteAgent={isAdmin ? () => setConfirmDeleteAgent(true) : undefined}
      resolvedInfo={resolvedInfo}
      sessions={sessions}
      activityLoading={loading}
      activityLoadingMore={loadingMore}
      activityHasMoreOlder={hasMoreOlder}
      onLoadMoreActivity={loadMoreOlderActivity}
      onRefreshActivity={loadActivityData}
      highlightTimestamp={effectiveHighlightTimestamp}
      onViewTimelineFromAlerts={(timestamp) => {
        setTimelineHighlight(timestamp);
        goToTool("activity");
      }}
    />
  );

  const version = agentVersion(resolvedInfo, agent);
  const systemControlAvailable = capabilityAvailable(resolvedInfo, "system_control");
  const isViewer = dashboardRole === "viewer";
  const canOperate = dashboardRole === "operator" || dashboardRole === "admin";
  const grants = useDeviceModuleGrants(agent.id, canOperate && agent.online);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Own header — the AppShell top bar stays hidden on this route. */}
        <AgentDetailHeader
          agent={agent}
          resolvedInfo={resolvedInfo}
          statusLabel={currentStatus.label}
          statusTextClass={tone.text}
          statusDotColor={tone.dot}
          openMobileNav={openMobileNav}
          onBackToOverview={onBackToOverview}
          isViewer={isViewer}
          systemControlAvailable={systemControlAvailable}
          pendingAction={pendingAction}
          onAction={runAgentAction}
        />

        {/* Body: the shell scrolls it, so the nav bar below can stick to the top of that scroller. */}
        <div ref={scrollContainerRef} className="min-h-0 flex-1">
          {grants.noneGranted && (
            <div className="px-3 pt-3 sm:px-5 sm:pt-4 md:px-8">
              <Alert>
                <AlertTitle>Nothing is turned on for {agent.name} yet</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>Turn modules on in the Vantyr app on {agent.name}.</span>
                  <Button variant="outline" size="sm" onClick={() => goToTool("settings")}>
                    View modules
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          )}
          {/* Live desktop first, full width; the device facts are a slim strip underneath. */}
          <div className="flex flex-col gap-3 px-3 pt-3 sm:px-5 sm:pt-4 md:px-8 [&>.screen-remote-panel]:flex-[0_0_auto]!">
            {/* Offline: no live panel to show, just the device facts. */}
            {agent.online && (
              <ScreenTab
                key={`${agent.id}:${dashboardAccountId ?? "unverified"}`}
                embedded
                agentId={agent.id}
                sendWsMessage={sendWsMessage}
                dashboardRole={dashboardRole}
                streamActive={agent.online}
                online={agent.online}
                agentInfo={resolvedInfo}
                placeholderTitle={liveStatus?.window}
                placeholderSub={liveStatus?.app}
              />
            )}
            <AgentVitals
              agent={agent}
              info={resolvedInfo}
              liveStatus={liveStatus}
              uptimeText={formatUptime(uptimeSecs)}
              lastSeenText={formatLastSeen(agent.last_seen)}
              version={version}
            />
          </div>

          <AgentSectionNav agentName={agent.name} activeTab={activeTab} onTabChange={goToTool} />

          {/* Tool content. At least a screen tall, so even a short tool can scroll up under the pinned bar. */}
          <div
            data-agent-tool-content
            className="min-h-[calc(100svh-4rem)] px-3 pt-4 pb-8 sm:px-5 md:px-8 md:py-6"
          >
            <ErrorBoundary resetKey={shownTab} label={`tab:${shownTab}`}>
              {tabContent}
            </ErrorBoundary>
          </div>
        </div>

        <AgentActionDialogs
          agentName={agent.name}
          confirmAction={confirmAction}
          setConfirmAction={setConfirmAction}
          pendingAction={pendingAction}
          confirmAndRun={confirmAndRun}
          confirmDeleteAgent={confirmDeleteAgent}
          setConfirmDeleteAgent={setConfirmDeleteAgent}
          deletingAgent={deletingAgent}
          deleteThisAgent={deleteThisAgent}
        />
      </main>
    </div>
  );
}

function AgentActionDialogs({
  agentName,
  confirmAction,
  setConfirmAction,
  pendingAction,
  confirmAndRun,
  confirmDeleteAgent,
  setConfirmDeleteAgent,
  deletingAgent,
  deleteThisAgent,
}: {
  agentName: string;
  confirmAction: AgentAction | null;
  setConfirmAction: (action: AgentAction | null) => void;
  pendingAction: AgentAction | null;
  confirmAndRun: () => void;
  confirmDeleteAgent: boolean;
  setConfirmDeleteAgent: (open: boolean) => void;
  deletingAgent: boolean;
  deleteThisAgent: () => void;
}) {
  return (
    <>
      <AlertDialog
        open={confirmAction === "restart-host" || confirmAction === "shutdown-host"}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "restart-host"
                ? `Restart ${agentName}?`
                : `Shut down ${agentName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "restart-host"
                ? "Unsaved work may be lost."
                : "You may need Wake on LAN to bring it back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pendingAction === "restart-host" || pendingAction === "shutdown-host"}
              onClick={confirmAndRun}
            >
              {(pendingAction === "restart-host" || pendingAction === "shutdown-host") && (
                <Spinner />
              )}
              {confirmAction === "restart-host" ? "Restart" : "Shutdown"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeleteAgent} onOpenChange={setConfirmDeleteAgent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agentName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the agent and its history. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAgent}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingAgent}
              onClick={deleteThisAgent}
            >
              {deletingAgent && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
