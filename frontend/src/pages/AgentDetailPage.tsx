import { Modal, Box, Button, SpaceBetween } from "../components/ui/console";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Power,
  RotateCw,
  Shield,
} from "lucide-react";
import type { Agent, AgentInfo, AgentLiveStatus, DashboardRole, TabKey } from "../lib/types";
import { api } from "../lib/api";
import {
  AGENT_TAB_META,
  AGENT_SECTION_ORDER,
  AGENT_SECTION_META,
  AGENT_SECTION_SUBTABS,
  agentSectionFromTabKey,
  defaultTabForAgentSection,
} from "../lib/agentTabNav";
import { AgentDetailTabContent } from "../components/detail/AgentDetailTabContent";
import { AgentVitals } from "../components/detail/AgentVitals";
import { ScreenTab } from "../components/tabs/ScreenTab";
import { ConsoleButton, OsBadge, type ConsoleStatus, type OsKind } from "../components/ui/console";
import { Dot } from "../components/common/Metrics";
import { useAgentActivitySessions } from "../hooks/useAgentActivitySessions";
import { useAgentInferredIdle } from "../hooks/useAgentInferredIdle";
import { useResolvedAgentInfo } from "../hooks/useResolvedAgentInfo";
import { useMobileNavOpener } from "../layouts/DashboardLayout";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { Menu } from "lucide-react";

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
  // Prefer IPv4 (no colons)
  for (const adapter of info?.adapters ?? []) {
    const ip = adapter.ips?.find((c) => c && !c.startsWith("127.") && c !== "::1" && !c.includes(":"));
    if (ip) return ip;
  }
  // Fallback to any non-loopback
  for (const adapter of info?.adapters ?? []) {
    const ip = adapter.ips?.find((c) => c && !c.startsWith("127.") && c !== "::1");
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

function statusTone(status: ConsoleStatus): { color: string; soft: string } {
  if (status === "afk") return { color: "var(--amber)", soft: "var(--amber-soft)" };
  if (status === "blocked" || status === "danger") return { color: "var(--red)", soft: "var(--red-soft)" };
  if (status === "offline") return { color: "var(--tx-3)", soft: "rgba(255,255,255,0.05)" };
  return { color: "var(--gr)", soft: "var(--gr-soft)" };
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
}: AgentDetailPageProps) {
  const [timelineHighlight, setTimelineHighlight] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<AgentAction | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { resolvedInfo } = useResolvedAgentInfo(agent.id, agentInfo);
  const openMobileNav = useMobileNavOpener();
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

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100%", background: "var(--bg)" }}>
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100%" }}>
        <section
          className="agent-detail-header"
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
          <div className="agent-detail-identity" style={{ display: "flex", alignItems: "center", gap: 16, minWidth: 0 }}>
            {openMobileNav && (
              <button
                type="button"
                onClick={openMobileNav}
                className="detail-nav-toggle"
                aria-label="Open navigation menu"
                title="Menu"
                style={{
                  display: "none",
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
                <Menu size={18} />
              </button>
            )}
            {onBackToOverview && (
              <button
                type="button"
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
            <OsBadge os={osFromInfo(resolvedInfo)} className="vantyr-detail-os" />
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
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 9px",
                    borderRadius: 99,
                    background: statusTone(currentStatus.status).soft,
                  }}
                >
                  <Dot color={statusTone(currentStatus.status).color} size={6} halo={false} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: statusTone(currentStatus.status).color }}>
                    {currentStatus.label}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 3, flexWrap: "wrap" }}>
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
          <div className="agent-detail-actions" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <ConsoleButton
              icon={Shield}
              variant="ghost"
              disabled={!agent.online}
              onClick={() => runAgentAction("lock-host")}
            >
              <span className="btn-label">Lock</span>
            </ConsoleButton>
            <ConsoleButton
              icon={RotateCw}
              variant="ghost"
              disabled={!agent.online}
              onClick={() => runAgentAction("restart-host")}
            >
              <span className="btn-label">Restart</span>
            </ConsoleButton>
            <ConsoleButton
              icon={Power}
              variant="danger"
              disabled={!agent.online}
              onClick={() => runAgentAction("shutdown-host")}
            >
              <span className="btn-label">Shutdown</span>
            </ConsoleButton>
            {!agent.online && (
              <ConsoleButton
                icon={Power}
                variant="primary"
                disabled={pendingAction === "wake-lan"}
                onClick={() => runAgentAction("wake-lan")}
              >
                <span className="btn-label">Wake</span>
              </ConsoleButton>
            )}
          </div>
        </section>

        {/* Scroll body: live screen + vitals, tabs, and tab content scroll together */}
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {/* Combined top: live screen + vitals card */}
          <div className="agent-detail-top-panel" style={{ display: "flex", gap: 16, padding: "18px 26px 0", alignItems: "stretch" }}>
            <ScreenTab
              embedded
              agentId={agent.id}
              sendWsMessage={sendWsMessage}
              dashboardRole={dashboardRole}
              streamActive={agent.online}
              online={agent.online}
              placeholderTitle={liveStatus?.window}
              placeholderSub={liveStatus?.app}
            />
            <AgentVitals
              className="agent-vitals"
              agent={agent}
              info={resolvedInfo}
              liveStatus={liveStatus}
              uptimeText={formatUptime(uptimeSecs)}
              lastSeenText={formatLastSeen(agent.last_seen)}
              version={version}
            />
          </div>

          {/* Primary section tabs (underline) */}
          <div
            className="agent-detail-section-tabs"
            style={{
              display: "flex",
              gap: 4,
              padding: "0 26px",
              margin: "20px 0 0",
              borderBottom: "1px solid var(--line)",
              overflowX: "auto",
            }}
          >
            {AGENT_SECTION_ORDER.map((section) => {
              const meta = AGENT_SECTION_META[section];
              const Icon = meta.icon;
              const on = section === activeSection;
              return (
                <button
                  key={section}
                  type="button"
                  onClick={() => onTabChange(defaultTabForAgentSection(section))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 14px",
                    cursor: "pointer",
                    color: on ? "var(--tx)" : "var(--tx-3)",
                    border: 0,
                    borderBottom: `2px solid ${on ? "var(--gr)" : "transparent"}`,
                    marginBottom: -1,
                    fontWeight: on ? 600 : 500,
                    fontSize: 13,
                    background: "transparent",
                    whiteSpace: "nowrap",
                    outline: "none",
                    fontFamily: "var(--font)",
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>

          {/* Secondary sub-tabs (pills) — only when the section has more than one */}
          {sectionSubtabs.length > 1 && (
            <div
              className="agent-detail-subtabs"
              style={{
                display: "flex",
                gap: 6,
                padding: "12px 26px",
                background: "var(--bg-soft)",
                borderBottom: "1px solid var(--line)",
                overflowX: "auto",
              }}
            >
              {sectionSubtabs.map((tab) => {
                const meta = AGENT_TAB_META[tab];
                const Icon = meta.icon;
                const on = shownTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => onTabChange(tab)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      color: on ? "var(--gr)" : "var(--tx-3)",
                      background: on ? "var(--gr-soft)" : "transparent",
                      fontWeight: on ? 600 : 500,
                      fontSize: 12.5,
                      whiteSpace: "nowrap",
                      outline: "none",
                      fontFamily: "var(--font)",
                    }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{meta.sideNavLabel}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Tab content */}
          <div className="sx-console agent-detail-content" style={{ padding: "18px 26px 26px" }}>
            <ErrorBoundary resetKey={shownTab} label={`tab:${shownTab}`}>
              {tabContent}
            </ErrorBoundary>
          </div>
        </div>

        <style>{`
          .agent-vitals {
            width: 300px;
            flex: 0 0 300px;
          }
          .detail-nav-toggle { display: none; }

          @media (max-width: 768px) {
            .agent-detail-header {
              padding: 10px 14px !important;
              flex-wrap: wrap;
              gap: 8px;
            }
            .agent-detail-identity {
              gap: 10px !important;
            }
            .detail-nav-toggle {
              display: flex !important;
            }
            .agent-detail-actions {
              gap: 5px !important;
            }
            .agent-detail-top-panel {
              flex-direction: column !important;
              padding: 12px 14px 0 !important;
              gap: 12px !important;
            }
            .agent-detail-top-panel > *:first-child {
              flex: 0 0 auto !important;
              width: 100% !important;
            }
            .agent-vitals {
              width: 100% !important;
              flex: 1 1 auto !important;
            }
            .agent-detail-section-tabs {
              padding: 0 14px !important;
            }
            .agent-detail-subtabs {
              padding: 10px 14px !important;
            }
            .agent-detail-content {
              padding: 14px 14px 24px !important;
            }
          }

          @media (max-width: 520px) {
            .agent-detail-header {
              padding: 8px 12px !important;
            }
            .agent-detail-actions .btn-label {
              display: none;
            }
            .agent-detail-top-panel {
              padding: 10px 12px 0 !important;
            }
            .agent-detail-section-tabs {
              padding: 0 12px !important;
            }
            .agent-detail-subtabs {
              padding: 8px 12px !important;
            }
            .agent-detail-content {
              padding: 12px 12px 20px !important;
            }
          }
        `}</style>

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
