import { notifyAgentRemoved } from "@/api/agentEvents";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Power,
  RotateCw,
  Shield,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Agent, AgentInfo, AgentLiveStatus, DashboardRole } from "@/api/types";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import { api } from "@/api";
import {
  AGENT_TAB_META,
  AGENT_SECTION_ORDER,
  AGENT_SECTION_META,
  AGENT_SECTION_SUBTABS,
  agentSectionFromTabKey,
  defaultTabForAgentSection,
} from "@/features/agent-detail/lib/agentTabNav";
import { AgentDetailTabContent } from "@/features/agent-detail/components/AgentDetailTabContent";
import { AgentVitals } from "@/features/agent-detail/components/AgentVitals";
import { ScreenTab } from "@/features/remote/components/ScreenTab";
import { OsBadge, type OsKind } from "@/components/common/OsBadge";
import { Dot } from "@/components/common/Metrics";
import { useAgentActivitySessions } from "@/features/activity/useAgentActivitySessions";
import { useResolvedAgentInfo } from "./useResolvedAgentInfo";
import { useMobileNavOpener } from "@/app/shell/useMobileNavOpener";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { Menu } from "lucide-react";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";

type AgentAction = "restart-host" | "shutdown-host" | "lock-host" | "request-info" | "wake-lan";
type AgentStatus = "connected" | "active" | "afk" | "offline";
type AgentSection = "activity" | "telemetry" | "system" | "control" | "settings";

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

function formatUptime(secs?: number | null) {
  if (secs == null || secs < 0) return "-";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatLastSeen(timestamp: string | null | undefined) {
  if (!timestamp) return "Never";
  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) return "Unknown";
  const diffSec = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  const mins = Math.floor(diffSec / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return `${diffSec}s ago`;
}

function osFromInfo(info: AgentInfo | null | undefined): OsKind {
  const os = `${info?.os_name ?? ""} ${info?.kernel_version ?? ""}`.toLowerCase();
  if (os.includes("windows")) return "windows";
  if (os.includes("darwin") || os.includes("mac")) return "macos";
  if (os.includes("docker")) return "docker";
  if (/linux|ubuntu|debian|fedora|cent\s?os|red\s?hat|rhel|arch|alpine|suse|mint|rocky|alma|gentoo|kali|manjaro|raspbian/.test(os))
    return "linux";
  return "unknown";
}

function statusFor(agent: Agent, liveStatus?: AgentLiveStatus): { status: AgentStatus; label: string } {
  if (!agent.online) return { status: "offline", label: "Offline" };
  if (liveStatus?.activity === "afk") return { status: "afk", label: "AFK" };
  if (liveStatus?.activity === "active") return { status: "active", label: "Active now" };
  return { status: "connected", label: "Connected" };
}

/** Status is carried by hue on the status word (plus a matching dot) — no pill badges. */
function statusTone(status: AgentStatus): { text: string; dot: string } {
  if (status === "afk") return { text: "text-warning", dot: "var(--warning)" };
  if (status === "offline") return { text: "text-muted-foreground", dot: "var(--muted-foreground)" };
  return { text: "text-success", dot: "var(--success)" };
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

  useEffect(() => {
    if (searchParams.get("scroll") === "activity" && scrollContainerRef.current) {
      setTimeout(() => {
        const tabsEl = scrollContainerRef.current?.querySelector(".agent-detail-section-tabs") as HTMLElement;
        if (tabsEl) {
          scrollContainerRef.current?.scrollTo({
            top: tabsEl.offsetTop,
            behavior: "smooth",
          });
        }
      }, 100);
    }
  }, [searchParams, agent.id]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const effectiveHighlightTimestamp = timelineHighlight ?? highlightTimestamp ?? null;
  const currentStatus = statusFor(agent, liveStatus);
  const tone = statusTone(currentStatus.status);
  const infoUpdatedTsSecs =
    typeof resolvedInfo?.ts === "number" && Number.isFinite(resolvedInfo.ts) ? resolvedInfo.ts : null;
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
    [agent.id, agent.name, agent.online, dashboardRole, onNotifyError, onNotifyInfo, onNotifyWarning, sendWsMessage],
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
  }, [agent.id, agent.name, agent.online, confirmAction, dashboardRole, onNotifyError, onNotifyWarning, sendWsMessage]);

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
        onTabChange("activity");
      }}
    />
  );

  const activeSection = agentSectionFromTabKey(shownTab);
  const sectionSubtabs = AGENT_SECTION_SUBTABS[activeSection];
  const version = resolvedInfo?.agent_version ?? agent.agent_version ?? "-";
  const systemControlAvailable = capabilityAvailable(resolvedInfo, "system_control");
  const isViewer = dashboardRole === "viewer";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Own header — the AppShell top bar stays hidden on this route. */}
        <section aria-label="Agent header" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-3 border-b border-foreground/[0.06] px-5 py-4 md:px-8">
          {/* Left: back/menu nav buttons (a sibling of identity so they can share the
              top row with the action buttons on mobile) */}
          {(openMobileNav || onBackToOverview) && (
            <div className="order-1 flex shrink-0 items-center gap-2">
              {openMobileNav && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={openMobileNav}
                  aria-label="Open navigation menu"
                  title="Menu"
                  className="md:hidden"
                >
                  <Menu />
                </Button>
              )}
              {onBackToOverview && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onBackToOverview}
                  title="Back to fleet"
                  aria-label="Back to fleet"
                >
                  <ArrowLeft />
                </Button>
              )}
            </div>
          )}

          {/* OS mark + identity */}
          <div className="order-3 flex min-w-0 flex-1 basis-full items-center gap-3 sm:order-2 sm:basis-auto sm:flex-1 sm:w-auto">
            <OsBadge os={osFromInfo(resolvedInfo)} size={32} className="text-foreground" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="truncate font-heading text-xl font-bold tracking-tight">
                  {agent.name}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Dot color={tone.dot} size={6} halo={false} />
                  <span className={`text-xs font-semibold ${tone.text}`}>
                    {currentStatus.label}
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* Right: actions */}
          <div className="order-2 ml-auto flex shrink-0 items-center gap-2 sm:order-3 sm:ml-0">
            {!isViewer && (
              <>
                <Button
                  variant="ghost"
                  size="lg"
                  disabled={!agent.online || !systemControlAvailable}
                  onClick={() => runAgentAction("lock-host")}
                >
                  <Shield />
                  <span className="hidden sm:inline">Lock</span>
                </Button>
                <Button
                  variant="ghost"
                  size="lg"
                  disabled={!agent.online || !systemControlAvailable}
                  onClick={() => runAgentAction("restart-host")}
                >
                  <RotateCw />
                  <span className="hidden sm:inline">Restart</span>
                </Button>
                <Button
                  variant="destructive"
                  size="lg"
                  disabled={!agent.online || !systemControlAvailable}
                  onClick={() => runAgentAction("shutdown-host")}
                >
                  <Power />
                  <span className="hidden sm:inline">Shutdown</span>
                </Button>
              </>
            )}
            {!agent.online && !isViewer && (
              <Button
                size="lg"
                disabled={pendingAction === "wake-lan"}
                onClick={() => runAgentAction("wake-lan")}
              >
                {pendingAction === "wake-lan" && <Spinner />}
                <Power />
                <span className="hidden sm:inline">Wake</span>
              </Button>
            )}
          </div>
        </section>

        {/* Scroll body: live screen + vitals, tabs, and tab content scroll together */}
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          {/* Combined top: live screen + vitals card */}
          <div className="flex flex-col gap-4 px-5 pt-4 md:px-8 lg:flex-row">
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
            <AgentVitals
              className="w-full lg:w-[300px] lg:shrink-0"
              agent={agent}
              info={resolvedInfo}
              liveStatus={liveStatus}
              uptimeText={formatUptime(uptimeSecs)}
              lastSeenText={formatLastSeen(agent.last_seen)}
              version={version}
            />
          </div>

          {/* Primary section tabs */}
          <Tabs
            value={activeSection}
            onValueChange={(v) => onTabChange(defaultTabForAgentSection(v as AgentSection))}
            className="agent-detail-section-tabs mt-5 border-b border-foreground/[0.06] px-5 md:px-8"
          >
            <TabsList variant="line" aria-label="Agent sections" className="h-11! w-full justify-start gap-2 overflow-x-auto p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {AGENT_SECTION_ORDER.map((section) => {
                const meta = AGENT_SECTION_META[section];
                const Icon = meta.icon;
                return (
                  <TabsTrigger key={section} value={section} className="h-full! flex-none gap-2 px-2.5">
                    <Icon size={15} aria-hidden="true" />
                    <span>{meta.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          {/* Secondary sub-tabs — only when the section has more than one */}
          {sectionSubtabs.length > 1 && (
            <div className="px-5 pt-6 md:px-8 lg:px-10">
              <Tabs value={shownTab} onValueChange={(v) => onTabChange(v as TabKey)} className="min-w-0">
                <TabsList aria-label="Section pages" className="max-w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {sectionSubtabs.map((tab) => {
                    const meta = AGENT_TAB_META[tab];
                    const Icon = meta.icon;
                    return (
                      <TabsTrigger key={tab} value={tab} className="flex-none gap-2">
                        <Icon size={14} aria-hidden="true" />
                        <span>{meta.sideNavLabel}</span>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            </div>
          )}

          {/* Tab content */}
          <div className="px-5 py-6 md:px-8 md:py-8 lg:px-10">
            <ErrorBoundary resetKey={shownTab} label={`tab:${shownTab}`}>
              {tabContent}
            </ErrorBoundary>
          </div>

          {/* Danger zone (admin only): delete this agent */}
          {isAdmin && (
            <div className="px-5 pb-8 md:px-8 lg:px-10">
              <Alert variant="destructive">
                <AlertTitle>Danger zone</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>Removes the agent and its history.</span>
                  <Button variant="destructive" size="sm" onClick={() => setConfirmDeleteAgent(true)}>
                    Delete agent
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          )}
        </div>

        <AlertDialog open={confirmAction === "restart-host" || confirmAction === "shutdown-host"} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmAction === "restart-host" ? `Restart ${agent.name}?` : `Shut down ${agent.name}?`}</AlertDialogTitle>
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
                {(pendingAction === "restart-host" || pendingAction === "shutdown-host") && <Spinner />}
                {confirmAction === "restart-host" ? "Restart" : "Shutdown"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmDeleteAgent} onOpenChange={setConfirmDeleteAgent}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes the agent and its history. It won't reconnect until
                re-enrolled. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deletingAgent}>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={deletingAgent} onClick={deleteThisAgent}>
                {deletingAgent && <Spinner />} Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </div>
  );
}
