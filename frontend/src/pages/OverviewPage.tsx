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
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const overviewStats = [
    {
      label: "Connected",
      value: onlineAgents.length,
      meta: "ready for live actions",
      tone: "connected",
    },
    {
      label: "Active now",
      value: activeAgents.length,
      meta: "generating telemetry",
      tone: "active",
    },
    {
      label: "AFK",
      value: afkAgents.length,
      meta: "idle but connected",
      tone: "afk",
    },
    {
      label: "Offline",
      value: offlineAgents,
      meta: "awaiting reconnect",
      tone: "offline",
    },
  ] as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {hasAgents ? (
        <div style={{ padding: "16px 24px 0" }}>
          <FleetSnapshot items={[...overviewStats]} total={agentList.length} />
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
            onAddAgent={showAddAgent ? () => setAddAgentOpen(true) : undefined}
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
          />
        ) : (
          <div style={{ padding: 24 }}>
            <NoAgentsState
              primaryAction={
                showAddAgent ? (
                  <button
                    onClick={() => setAddAgentOpen(true)}
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
      {showAddAgent ? (
        <AddAgentModal visible={addAgentOpen} onDismiss={() => setAddAgentOpen(false)} />
      ) : null}
    </div>
  );
}
