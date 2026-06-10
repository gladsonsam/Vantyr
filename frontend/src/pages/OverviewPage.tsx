import { useState } from "react";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Container from "@cloudscape-design/components/container";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { Agent, AgentInfo, AgentLiveStatus } from "../lib/types";
import { AgentCard } from "../components/overview/AgentCard";
import { AddAgentModal } from "../components/overview/AddAgentModal";
import { BulkScriptModal } from "../components/overview/BulkScriptModal";
import { BulkAddToGroupModal } from "../components/overview/BulkAddToGroupModal";
import { LoadingAgentsState, NoAgentsState } from "../components/common/EmptyState";
import { api } from "../lib/api";

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
      meta: "Ready for live actions",
      tone: "success",
    },
    {
      label: "Offline",
      value: offlineAgents,
      meta: "Awaiting reconnect",
      tone: "neutral",
    },
    {
      label: "Active now",
      value: activeAgents.length,
      meta: "Generating fresh telemetry",
      tone: "info",
    },
    {
      label: "AFK",
      value: afkAgents.length,
      meta: "Idle but still connected",
      tone: "warning",
    },
  ] as const;

  return (
    <ContentLayout>
      <SpaceBetween size="l">
        {hasAgents ? (
          <Container className="sentinel-overview-hero" disableContentPaddings>
            <div className="sentinel-overview-hero__inner">
              <div className="sentinel-overview-hero__copy">
                <Box variant="h2" className="sentinel-overview-hero__eyebrow">
                  Fleet snapshot
                </Box>
                <Box variant="h1" className="sentinel-overview-hero__title">
                  Agents overview
                </Box>
                <Box variant="p" color="text-body-secondary" className="sentinel-overview-hero__description">
                  A live view of connection health, activity state, and the fastest actions for the fleet.
                </Box>
              </div>

              <div className="sentinel-overview-hero__stats" aria-label="Fleet summary">
                {overviewStats.map((stat) => (
                  <div
                    key={stat.label}
                    className={`sentinel-overview-metric sentinel-overview-metric--${stat.tone}`}
                  >
                    <div className="sentinel-overview-metric__head">
                      <span className="sentinel-overview-metric__dot" aria-hidden="true" />
                      <span className="sentinel-overview-metric__label">{stat.label}</span>
                    </div>
                    <div className="sentinel-overview-metric__value">{stat.value}</div>
                    <div className="sentinel-overview-metric__meta">{stat.meta}</div>
                  </div>
                ))}
              </div>
            </div>
          </Container>
        ) : null}

        <div className="sentinel-overview-root">
          {loadingAgents ? (
            <LoadingAgentsState />
          ) : hasAgents ? (
            <AgentCard
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
