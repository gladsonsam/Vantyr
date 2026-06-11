import { Modal, Box, Button, SpaceBetween } from "../components/ui/console";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Info,
  MonitorPlay,
  Power,
  RefreshCw,
  RotateCw,
  Shield,
} from "lucide-react";
import type { Agent, AgentInfo, AgentLiveStatus, DashboardRole, TabKey } from "../lib/types";
import { api } from "../lib/api";
import { AGENT_TAB_META } from "../lib/agentTabNav";
import { AgentDetailTabContent } from "../components/detail/AgentDetailTabContent";
import { AgentMiniList } from "../components/detail/AgentMiniList";
import { AgentQuickStats } from "../components/detail/AgentQuickStats";
import { ConsoleButton, OsBadge, StatusPill, type ConsoleStatus, type OsKind } from "../components/ui/console";
import { useAgentActivitySessions } from "../hooks/useAgentActivitySessions";
import { useAgentInferredIdle } from "../hooks/useAgentInferredIdle";
import { useResolvedAgentInfo } from "../hooks/useResolvedAgentInfo";

type AgentAction = "restart-host" | "shutdown-host" | "lock-host" | "request-info" | "wake-lan";

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
  onOpenHelp: () => void;
  highlightTimestamp?: string | null;
  isAdmin?: boolean;
  onOpenAgentGroups?: () => void;
  dashboardRole?: DashboardRole | null;
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
  if (os.includes("linux")) return "linux";
  return "unknown";
}

function primaryIp(info: AgentInfo | null | undefined) {
  for (const adapter of info?.adapters ?? []) {
    const ip = adapter.ips?.find((candidate) => candidate && !candidate.startsWith("127.") && candidate !== "::1");
    if (ip) return ip;
  }
  return "-";
}

function statusFor(agent: Agent, liveStatus?: AgentLiveStatus): { status: ConsoleStatus; label: string } {
  if (!agent.online) return { status: "offline", label: "Offline" };
  if (liveStatus?.activity === "afk") return { status: "afk", label: "AFK" };
  if (liveStatus?.activity === "active") return { status: "active", label: "Active now" };
  return { status: "connected", label: "Connected" };
}

export function AgentDetailPage({
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
  highlightTimestamp,
  onOpenHelp: _onOpenHelp,
  isAdmin = false,
  onOpenAgentGroups,
  dashboardRole = null,
}: AgentDetailPageProps) {
  const [timelineHighlight, setTimelineHighlight] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<AgentAction | null>(null);
  const [infoRequestedAtMs, setInfoRequestedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { resolvedInfo } = useResolvedAgentInfo(agent.id, agentInfo);
  const inferredIdleSeconds = useAgentInferredIdle(agent.id, liveStatus?.activity);
  const { sessions, loading, loadingMore, hasMoreOlder, loadMoreOlderActivity, loadActivityData } =
    useAgentActivitySessions(agent.id, activeTab);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const effectiveHighlightTimestamp = timelineHighlight ?? highlightTimestamp ?? null;
  const currentStatus = statusFor(agent, liveStatus);
  const infoUpdatedTsSecs =
    typeof resolvedInfo?.ts === "number" && Number.isFinite(resolvedInfo.ts) ? resolvedInfo.ts : null;
  const uptimeSecs = useMemo(() => {
    if (resolvedInfo?.uptime_secs == null) return undefined;
    if (!agent.online) return resolvedInfo.uptime_secs;
    const receivedAt = infoUpdatedTsSecs ? infoUpdatedTsSecs * 1000 : 0;
    if (!receivedAt) return resolvedInfo.uptime_secs;
    return resolvedInfo.uptime_secs + Math.max(0, Math.floor((nowMs - receivedAt) / 1000));
  }, [agent.online, infoUpdatedTsSecs, nowMs, resolvedInfo?.uptime_secs]);

  const idleText = useMemo(() => {
    if (!agent.online) return null;
    if (liveStatus?.activity === "afk") {
      const seconds =
        liveStatus.idleSinceMs != null
          ? Math.max(0, Math.floor((nowMs - liveStatus.idleSinceMs) / 1000))
          : liveStatus.idleSecs;
      return `Idle ${formatUptime(seconds)}`;
    }
    if (liveStatus?.activity === "active") return "Fresh telemetry";
    if (inferredIdleSeconds != null && inferredIdleSeconds >= 60) return `Idle ${formatUptime(inferredIdleSeconds)}`;
    return "Awaiting activity";
  }, [agent.online, inferredIdleSeconds, liveStatus, nowMs]);

  const runAgentAction = useCallback(
    (action: AgentAction) => {
      if (action === "wake-lan") {
        if (agent.online) {
          onNotifyInfo("Agent already online", `${agent.name} is connected. Wake on LAN is only needed while offline.`);
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
        onNotifyWarning("Agent offline", `Cannot run "${action}" while ${agent.name} is offline.`);
        return;
      }

      if (action === "request-info") {
        setPendingAction("request-info");
        setInfoRequestedAtMs(Date.now());
        sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "RequestInfo" } });
        setTimeout(() => setPendingAction((prev) => (prev === "request-info" ? null : prev)), 800);
        return;
      }

      if (action === "lock-host") {
        setPendingAction("lock-host");
        sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "LockHost" } });
        onNotifyWarning("Lock sent", `Sent lock command to ${agent.name}.`);
        setTimeout(() => setPendingAction((prev) => (prev === "lock-host" ? null : prev)), 800);
        return;
      }

      if (action === "restart-host" || action === "shutdown-host") {
        setConfirmAction(action);
      }
    },
    [agent.id, agent.name, agent.online, onNotifyError, onNotifyInfo, onNotifyWarning, sendWsMessage],
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
      sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "RestartHost" } });
      onNotifyWarning("Restart sent", `Sent restart command to ${agent.name}.`);
      setTimeout(() => setPendingAction((prev) => (prev === "restart-host" ? null : prev)), 800);
      return;
    }

    setPendingAction("shutdown-host");
    sendWsMessage({ type: "control", agent_id: agent.id, cmd: { type: "ShutdownHost" } });
    onNotifyWarning("Shutdown sent", `Sent shutdown command to ${agent.name}.`);
    setTimeout(() => setPendingAction((prev) => (prev === "shutdown-host" ? null : prev)), 800);
  }, [agent.id, agent.name, agent.online, confirmAction, onNotifyWarning, sendWsMessage]);

  const tabContent = (
    <AgentDetailTabContent
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
      highlightTimestamp={effectiveHighlightTimestamp}
      onViewTimelineFromAlerts={(timestamp) => {
        setTimelineHighlight(timestamp);
        onTabChange("activity");
      }}
    />
  );

  const liveReady = agent.online;
  const showRequested = infoRequestedAtMs != null && nowMs - infoRequestedAtMs < 15_000;
  const version = resolvedInfo?.agent_version ?? agent.agent_version ?? "-";

  return (
    <div className="vantyr-agent-command-shell sx-console">
      <AgentMiniList
        agents={agents}
        agentInfo={agentInfoById}
        liveStatus={liveStatusById}
        selectedAgentId={agent.id}
        onSelectAgent={onSelectAgent}
      />

      <main className="vantyr-agent-command-main">
        <section
          className="vantyr-agent-command-head"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 26px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg-soft)",
            gap: 16,
            marginBottom: 0,
          }}
        >
          {/* Left: back + OS chip + identity */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, minWidth: 0 }}>
            {onBackToOverview && (
              <button
                onClick={onBackToOverview}
                title="Back to fleet"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 36,
                  border: "1px solid var(--line-2)",
                  borderRadius: 10,
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--tx-2)",
                  flexShrink: 0,
                }}
              >
                <ArrowLeft size={17} />
              </button>
            )}
            <OsBadge os={osFromInfo(resolvedInfo)} className="vantyr-agent-command-head__os" />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    fontSize: 21,
                    fontWeight: 700,
                    fontFamily: "var(--display)",
                    color: "var(--tx)",
                    letterSpacing: "-0.02em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {agent.name}
                </span>
                <StatusPill status={currentStatus.status} pulse={currentStatus.status === "active"}>
                  {currentStatus.label}
                </StatusPill>
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 3 }}>
                <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontFamily: "var(--mono)" }}>
                  {resolvedInfo?.current_user || "-"}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontFamily: "var(--mono)" }}>
                  {primaryIp(resolvedInfo)}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontFamily: "var(--mono)" }}>
                  v{version}
                </span>
                {idleText && (
                  <span style={{ fontSize: 11.5, color: "var(--tx-3)" }}>{idleText}</span>
                )}
              </div>
            </div>
          </div>

          {/* Right: actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <ConsoleButton
              icon={Shield}
              disabled={!agent.online}
              onClick={() => runAgentAction("lock-host")}
            >
              Lock
            </ConsoleButton>
            <ConsoleButton
              icon={RefreshCw}
              variant="ghost"
              disabled={!agent.online || pendingAction === "request-info"}
              onClick={() => runAgentAction("request-info")}
            >
              {showRequested ? "Refreshing…" : "Refresh info"}
            </ConsoleButton>
            <ConsoleButton
              icon={agent.online ? MonitorPlay : Power}
              variant="primary"
              disabled={agent.online ? activeTab === "live" : pendingAction === "wake-lan"}
              onClick={() => (agent.online ? onTabChange("live") : runAgentAction("wake-lan"))}
            >
              {agent.online ? "Take control" : "Wake"}
            </ConsoleButton>
          </div>
        </section>

        <AgentQuickStats
          agent={agent}
          info={resolvedInfo}
          liveStatus={liveStatus}
          uptimeText={formatUptime(uptimeSecs)}
          lastSeenText={formatLastSeen(agent.last_seen)}
        />

        <section className="vantyr-agent-workspace">
          <div className="vantyr-agent-tab-rail">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--sx-text-dim)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Live Ops</div>
                {["activity", "live", "control"].map((tab) => {
                  const meta = AGENT_TAB_META[tab as TabKey];
                  const Icon = meta.icon;
                  const liveRestricted = !liveReady && (tab === "live" || tab === "control");
                  return (
                    <button
                      key={tab}
                      type="button"
                      className={activeTab === tab ? "is-active" : undefined}
                      onClick={() => onTabChange(tab as TabKey)}
                      style={{ display: 'flex', alignItems: 'center', gap: '9px', width: '100%', border: 0, background: 'transparent', cursor: 'pointer', outline: 'none' }}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span>{meta.sideNavLabel}</span>
                      {liveRestricted ? <span className="vantyr-agent-tab-rail__disabled-dot" /> : null}
                    </button>
                  );
                })}
              </div>

              <div>
                <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--sx-text-dim)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>System Specs</div>
                {["specs", "software", "scripts", "files"].map((tab) => {
                  const meta = AGENT_TAB_META[tab as TabKey];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={tab}
                      type="button"
                      className={activeTab === tab ? "is-active" : undefined}
                      onClick={() => onTabChange(tab as TabKey)}
                      style={{ display: 'flex', alignItems: 'center', gap: '9px', width: '100%', border: 0, background: 'transparent', cursor: 'pointer', outline: 'none' }}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span>{meta.sideNavLabel}</span>
                    </button>
                  );
                })}
              </div>

              <div>
                <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--sx-text-dim)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Telemetry Data</div>
                {["analytics", "keys", "windows", "urls", "alerts", "logs"].map((tab) => {
                  const meta = AGENT_TAB_META[tab as TabKey];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={tab}
                      type="button"
                      className={activeTab === tab ? "is-active" : undefined}
                      onClick={() => onTabChange(tab as TabKey)}
                      style={{ display: 'flex', alignItems: 'center', gap: '9px', width: '100%', border: 0, background: 'transparent', cursor: 'pointer', outline: 'none' }}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span>{meta.sideNavLabel}</span>
                    </button>
                  );
                })}
              </div>

              <div>
                <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--sx-text-dim)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Config</div>
                {["settings"].map((tab) => {
                  const meta = AGENT_TAB_META[tab as TabKey];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={tab}
                      type="button"
                      className={activeTab === tab ? "is-active" : undefined}
                      onClick={() => onTabChange(tab as TabKey)}
                      style={{ display: 'flex', alignItems: 'center', gap: '9px', width: '100%', border: 0, background: 'transparent', cursor: 'pointer', outline: 'none' }}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span>{meta.sideNavLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="vantyr-agent-content-panel">
          <div className="vantyr-agent-content-panel__head">
            <div>
              <h2 style={{ fontSize: "16px", margin: 0, fontWeight: 800, color: "var(--sx-text)" }}>
                {AGENT_TAB_META[activeTab].breadcrumbLabel}
              </h2>
            </div>
              <div className="vantyr-agent-content-panel__tools">
                <ConsoleButton icon={Info} variant="ghost" onClick={() => runAgentAction("request-info")} disabled={!agent.online}>
                  Sync
                </ConsoleButton>
                <ConsoleButton icon={RotateCw} variant="ghost" onClick={() => runAgentAction("restart-host")} disabled={!agent.online}>
                  Restart
                </ConsoleButton>
                <ConsoleButton icon={Power} variant="danger" onClick={() => runAgentAction("shutdown-host")} disabled={!agent.online}>
                  Shutdown
                </ConsoleButton>
              </div>
            </div>
            <div className="vantyr-agent-content-panel__body">{tabContent}</div>
          </div>
        </section>

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
          {confirmAction === "restart-host"
            ? `Restart "${agent.name}" now? Any unsaved work may be lost.`
            : `Shutdown "${agent.name}" now? You may need Wake on LAN to bring it back.`}
        </Modal>
      </main>
    </div>
  );
}
