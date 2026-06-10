import { ContentLayout, Button, SpaceBetween } from "../components/ui/console";
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
  /** Admin: show “Add selected to group” in bulk actions. */
  adminBulkGroupAssignment?: boolean;
  /** Admin: show Add agent (enrollment) on the overview. */
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
    <ContentLayout>
      <SpaceBetween size="l">
        {hasAgents ? (
          <div className="vantyr-overview-console-head sx-console">
            <div>
              <div className="vantyr-overview-console-head__eyebrow">Fleet snapshot</div>
              <h1>Agents overview</h1>
            </div>
            <FleetSnapshot items={[...overviewStats]} />
          </div>
        ) : null}

        <div className="vantyr-overview-root">
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
            <NoAgentsState
              primaryAction={
                showAddAgent ? (
                  <Button variant="primary" onClick={() => setAddAgentOpen(true)}>
                    Add agent
                  </Button>
                ) : undefined
              }
            />
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
      </SpaceBetween>
    </ContentLayout>
  );
}
