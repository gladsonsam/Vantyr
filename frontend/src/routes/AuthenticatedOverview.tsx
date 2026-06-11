import { useState } from "react";
import { DashboardLayout } from "../layouts/DashboardLayout";
import { OverviewPage } from "../pages/OverviewPage";
import type { Agent, AgentInfo, AgentLiveStatus, DashboardNavUser } from "../lib/types";
import type { NotificationItem } from "../hooks/useNotifications";
import { VI } from "../components/common/Icons";

interface Props {
  agents: Record<string, Agent>;
  liveStatus: Record<string, AgentLiveStatus>;
  agentInfo: Record<string, AgentInfo | null>;
  agentInfoReceivedAtMs: Record<string, number>;
  loadingAgents: boolean;
  onSelectAgent: (agentId: string) => void;
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
  toolsOpen: boolean;
  onToolsChange: (open: boolean) => void;
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
  onGoHome,
  currentUser = null,
  notifications,
  onDismissNotification,
  toolsOpen,
  onToolsChange,
}: Props) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "grid">("grid");
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const agentList = Object.values(agents);
  const totalAgents = agentList.length;
  const onlineAgents = agentList.filter((a) => a.online).length;

  const pageSub2 = totalAgents > 0
    ? `${totalAgents} enrolled · ${onlineAgents} online`
    : undefined;

  const topBarActions = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {/* Search hint */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px",
          borderRadius: 10,
          border: "1px solid var(--line-2)",
          cursor: "text",
          width: 220,
          background: "transparent",
        }}
        onClick={() => {
          const searchEl = document.querySelector<HTMLInputElement>(".vantyr-fleet-search input, .vantyr-fleet-search");
          searchEl?.focus();
        }}
      >
        <VI.search style={{ width: 15, height: 15, color: "var(--tx-3)", flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, color: "var(--tx-3)", whiteSpace: "nowrap", flex: 1 }}>
          {query || "Search agents…"}
        </span>
        <span style={{ fontSize: 11, color: "var(--tx-4)", fontFamily: "var(--mono)" }}>⌘K</span>
      </div>

      {/* View toggle */}
      <div
        style={{
          display: "flex",
          padding: 3,
          gap: 2,
          background: "var(--card)",
          border: "1px solid var(--line-2)",
          borderRadius: 10,
        }}
      >
        {([["grid", VI.grid, "Grid view"], ["table", VI.list, "List view"]] as const).map(([v, Icon, title]) => (
          <div
            key={v}
            title={title}
            onClick={() => setViewMode(v)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 28,
              borderRadius: 7,
              cursor: "pointer",
              background: viewMode === v ? "var(--card-3)" : "transparent",
              color: viewMode === v ? "var(--tx)" : "var(--tx-3)",
            }}
          >
            <Icon style={{ width: 16, height: 16 }} />
          </div>
        ))}
      </div>

      {/* Status filter shortcut */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 13px",
          borderRadius: 10,
          cursor: "pointer",
          background: "var(--card-2)",
          border: "1px solid var(--line-2)",
          color: "var(--tx-2)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <VI.chevD style={{ width: 14, height: 14 }} />
        Status
      </div>

      {/* Enroll button */}
      {currentUser?.role === "admin" && (
        <div
          onClick={() => setAddAgentOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 14px",
            borderRadius: 10,
            cursor: "pointer",
            background: "var(--gr)",
            color: "#06251a",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          <VI.plus style={{ width: 15, height: 15 }} />
          Enroll
        </div>
      )}
    </div>
  );

  return (
    <DashboardLayout
      content={
        <OverviewPage
          agents={agents}
          liveStatus={liveStatus}
          agentInfo={agentInfo}
          agentInfoReceivedAtMs={agentInfoReceivedAtMs}
          loadingAgents={loadingAgents}
          onSelectAgent={onSelectAgent}
          onOpenScreen={onOpenScreen}
          onRefresh={onRefresh}
          onBatchWake={onBatchWake}
          onBatchLock={onBatchLock}
          onBatchRestart={onBatchRestart}
          onBatchShutdown={onBatchShutdown}
          adminBulkGroupAssignment={currentUser?.role === "admin"}
          showAddAgent={false}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          searchQuery={query}
          onSearchChange={setQuery}
          addAgentOpen={addAgentOpen}
          onAddAgentClose={() => setAddAgentOpen(false)}
        />
      }
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenActivityLog={onOpenActivityLog}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onGoHome={onGoHome}
      currentUser={currentUser}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
      showTools={false}
      toolsOpen={toolsOpen}
      onToolsChange={onToolsChange}
      pageSub2={pageSub2}
      topBarActions={topBarActions}
    />
  );
}
