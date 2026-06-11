import { useState } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "../lib/types";
import { AddAgentModal } from "../components/overview/AddAgentModal";
import { BulkScriptModal } from "../components/overview/BulkScriptModal";
import { BulkAddToGroupModal } from "../components/overview/BulkAddToGroupModal";
import { LoadingAgentsState, NoAgentsState } from "../components/common/EmptyState";
import { api } from "../lib/api";
import { AgentFleetTable } from "../components/overview/AgentFleetTable";
import { FleetSnapshot } from "../components/overview/FleetSnapshot";

interface OverviewPageProps {
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
  adminBulkGroupAssignment?: boolean;
  showAddAgent?: boolean;
  /** Controlled view mode from parent (TopBar toggle) */
  viewMode?: "table" | "grid";
  onViewModeChange?: (mode: "table" | "grid") => void;
  /** Controlled search query from parent (TopBar search) */
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  /** Controlled add-agent modal state from parent (TopBar enroll button) */
  addAgentOpen?: boolean;
  onAddAgentClose?: () => void;
}

export function OverviewPage({
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
  adminBulkGroupAssignment,
  showAddAgent = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  searchQuery: controlledQuery,
  onSearchChange,
  addAgentOpen: controlledAddAgentOpen,
  onAddAgentClose,
}: OverviewPageProps) {
  const hasAgents = Object.keys(agents).length > 0;
  const agentList = Object.values(agents);
  const onlineAgents = agentList.filter((agent) => agent.online);
  const offlineAgents = agentList.length - onlineAgents.length;
  const activeAgents = agentList.filter(
    (agent) => agent.online && liveStatus[agent.id]?.activity === "active",
  );
  const afkAgents = agentList.filter(
    (agent) => agent.online && liveStatus[agent.id]?.activity === "afk",
  );
  const [bulkScriptIds, setBulkScriptIds] = useState<string[] | null>(null);
  const [bulkGroupIds, setBulkGroupIds] = useState<string[] | null>(null);
  const [internalAddAgentOpen, setInternalAddAgentOpen] = useState(false);

  const isControlled = controlledViewMode !== undefined;
  const addAgentOpen = controlledAddAgentOpen !== undefined ? controlledAddAgentOpen : internalAddAgentOpen;
  const closeAddAgent = onAddAgentClose ?? (() => setInternalAddAgentOpen(false));

  const overviewStats = [
    {
      label: "Connected",
      value: onlineAgents.length,
      meta: "ready for live actions",
      tone: "connected" as const,
    },
    {
      label: "Active now",
      value: activeAgents.length,
      meta: "generating telemetry",
      tone: "active" as const,
    },
    {
      label: "Idle / AFK",
      value: afkAgents.length,
      meta: "connected, idle",
      tone: "afk" as const,
    },
    {
      label: "Offline",
      value: offlineAgents,
      meta: offlineAgents > 0 ? `${offlineAgents} awaiting reconnect` : "none offline",
      tone: "offline" as const,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {hasAgents ? (
        <div style={{ padding: "16px 24px 0" }}>
          <FleetSnapshot items={overviewStats} total={agentList.length} />
        </div>
      ) : null}

      <div style={{ flex: 1 }}>
        {loadingAgents ? (
          <LoadingAgentsState />
        ) : hasAgents ? (
          <AgentFleetTable
            agents={agents}
            liveStatus={liveStatus}
            agentInfo={agentInfo}
            agentInfoReceivedAtMs={agentInfoReceivedAtMs}
            onSelectAgent={onSelectAgent}
            onOpenScreen={onOpenScreen}
            onRefresh={onRefresh}
            onBatchWake={onBatchWake}
            onBulkScript={(ids) => setBulkScriptIds(ids)}
            onBatchLock={onBatchLock}
            onBatchRestart={onBatchRestart}
            onBatchShutdown={onBatchShutdown}
            onBulkAddToGroup={
              adminBulkGroupAssignment ? (ids) => setBulkGroupIds(ids) : undefined
            }
            onAddAgent={
              showAddAgent || isControlled
                ? () => {
                    if (controlledAddAgentOpen !== undefined) {
                      // controlled from parent - parent handles the open state
                    } else {
                      setInternalAddAgentOpen(true);
                    }
                  }
                : undefined
            }
            onDeleteAgents={
              showAddAgent
                ? (ids) => {
                    void api
                      .deleteAgents(ids)
                      .then(() => onRefresh())
                      .catch((e: unknown) => {
                        alert(String((e as { message?: string })?.message ?? e));
                      });
                  }
                : undefined
            }
            controlledViewMode={controlledViewMode}
            onViewModeChange={onViewModeChange}
            controlledQuery={controlledQuery}
            onQueryChange={onSearchChange}
          />
        ) : (
          <div style={{ padding: 24 }}>
            <NoAgentsState
              primaryAction={
                showAddAgent ? (
                  <button
                    onClick={() => setInternalAddAgentOpen(true)}
                    style={{
                      padding: "8px 14px",
                      borderRadius: 10,
                      background: "var(--gr)",
                      color: "#06251a",
                      border: "none",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Add agent
                  </button>
                ) : undefined
              }
            />
          </div>
        )}
      </div>

      {bulkScriptIds && bulkScriptIds.length > 0 ? (
        <BulkScriptModal agentIds={bulkScriptIds} onDismiss={() => setBulkScriptIds(null)} />
      ) : null}
      {bulkGroupIds && bulkGroupIds.length > 0 ? (
        <BulkAddToGroupModal agentIds={bulkGroupIds} onDismiss={() => setBulkGroupIds(null)} />
      ) : null}
      <AddAgentModal visible={addAgentOpen} onDismiss={closeAddAgent} />
    </div>
  );
}
