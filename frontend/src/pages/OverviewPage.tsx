import { useState } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "../lib/types";
import { AddAgentModal } from "../components/overview/AddAgentModal";
import { BulkScriptModal } from "../components/overview/BulkScriptModal";
import { BulkAddToGroupModal } from "../components/overview/BulkAddToGroupModal";
import { LoadingAgentsState, NoAgentsState } from "../components/common/EmptyState";
import { api } from "../lib/api";
import { AgentFleetTable } from "../components/overview/AgentFleetTable";
import { PendingAgentApprovals, PendingAgentClaim } from "../components/overview/PendingAgentApprovals";

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
  enrollClaims?: PendingAgentClaim[];
  enrollClaimsLoading?: boolean;
  enrollClaimsLoadedAt?: Date | null;
  onRefreshClaims?: () => void;
  onApproveClaim?: (claim: PendingAgentClaim, agentName: string) => Promise<void>;
  onRejectClaim?: (claim: PendingAgentClaim) => Promise<void>;
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
  enrollClaims,
  enrollClaimsLoading,
  enrollClaimsLoadedAt,
  onRefreshClaims,
  onApproveClaim,
  onRejectClaim,
}: OverviewPageProps) {
  const hasAgents = Object.keys(agents).length > 0;
  const [bulkScriptIds, setBulkScriptIds] = useState<string[] | null>(null);
  const [bulkGroupIds, setBulkGroupIds] = useState<string[] | null>(null);
  const [internalAddAgentOpen, setInternalAddAgentOpen] = useState(false);

  const addAgentOpen = controlledAddAgentOpen !== undefined ? controlledAddAgentOpen : internalAddAgentOpen;
  const closeAddAgent = onAddAgentClose ?? (() => setInternalAddAgentOpen(false));

  const hasPendingClaims = enrollClaims && enrollClaims.some((claim) => claim.status === "pending");

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {hasPendingClaims && (
        <div style={{ padding: "16px 24px 0" }}>
          <PendingAgentApprovals
            claims={enrollClaims}
            loading={enrollClaimsLoading}
            lastRefreshedAt={enrollClaimsLoadedAt}
            onRefresh={onRefreshClaims}
            onApprove={onApproveClaim || (() => Promise.resolve())}
            onReject={onRejectClaim || (() => Promise.resolve())}
          />
        </div>
      )}
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
              showAddAgent && controlledAddAgentOpen === undefined
                ? () => setInternalAddAgentOpen(true)
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
