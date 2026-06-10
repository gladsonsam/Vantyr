import { useEffect, useMemo, useState } from "react";
import Cards from "@cloudscape-design/components/cards";
import Box from "@cloudscape-design/components/box";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import TextFilter from "@cloudscape-design/components/text-filter";
import Pagination from "@cloudscape-design/components/pagination";
import Modal from "@cloudscape-design/components/modal";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useCollection } from "@cloudscape-design/collection-hooks";
import type { Agent, AgentInfo, AgentLiveStatus } from "../../lib/types";
import {
  agentCardDisplayName,
  createCardDefinitions,
  type AgentCardItem,
} from "../../lib/cards-config";
import { FullPageHeader } from "./FullPageHeader";
import { TableEmptyState, TableNoMatchState } from "../common/CollectionStates";
import { api } from "../../lib/api";
import type { AppBlockRule } from "../../lib/types";

interface AgentCardProps {
  agents: Record<string, Agent>;
  liveStatus: Record<string, AgentLiveStatus>;
  agentInfo: Record<string, AgentInfo | null>;
  agentInfoReceivedAtMs: Record<string, number>;
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  onRefresh: () => void;
  onBatchWake: (agentIds: string[]) => void;
  onBulkScript: (agentIds: string[]) => void;
  onBatchLock: (agentIds: string[]) => void;
  onBatchRestart: (agentIds: string[]) => void;
  onBatchShutdown: (agentIds: string[]) => void;
  /** Admin: opens group picker to add all selected agents to a group. */
  onBulkAddToGroup?: (agentIds: string[]) => void;
  /** Admin: open add-agent / enrollment flow. */
  onAddAgent?: () => void;
  /** Admin: delete agents from the server (forget). */
  onDeleteAgents?: (agentIds: string[]) => void;
}

export function AgentCard({
  agents,
  liveStatus,
  agentInfo,
  agentInfoReceivedAtMs,
  onSelectAgent,
  onOpenScreen,
  onRefresh,
  onBatchWake,
  onBulkScript,
  onBatchLock,
  onBatchRestart,
  onBatchShutdown,
  onBulkAddToGroup,
  onAddAgent,
  onDeleteAgents,
}: AgentCardProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fallbackLastWindow, setFallbackLastWindow] = useState<Record<string, string>>({});
  const [fallbackUptime, setFallbackUptime] = useState<Record<string, { secs: number; receivedAtMs: number }>>({});
  const [internetBlockedByAgent, setInternetBlockedByAgent] = useState<
    Record<string, { blocked: boolean; source: string | null; fetchedAtMs: number }>
  >({});
  const [appBlockByAgent, setAppBlockByAgent] = useState<
    Record<string, { enabledCount: number; examples: string[]; fetchedAtMs: number }>
  >({});
  const [powerModal, setPowerModal] = useState<null | { agentId: string }>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "connected" | "disconnected" | "afk">("all");

  // Dev-friendly defaults: avoid persisting card preferences in localStorage.
  const visibleSections = useMemo(
    () => ["main"],
    [],
  );
  const pageSize = 12;

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const allAgents = Object.entries(agents);

    for (const [id, agent] of allAgents) {
      // Seed "Last window" from stored telemetry if we haven't seen a live window_focus yet.
      // Do this for offline agents too so cards stay aligned.
      const hasLiveWindow = Boolean(liveStatus[id]?.window);
      if (!hasLiveWindow && fallbackLastWindow[id] == null) {
        api
          .windows(id, { limit: 1, offset: 0 })
          .then(({ rows }) => {
            if (cancelled) return;
            const title = rows[0]?.title;
            if (typeof title === "string" && title.trim() !== "") {
              setFallbackLastWindow((prev) => (prev[id] ? prev : { ...prev, [id]: title }));
            }
          })
          .catch(() => { /* ignore */ });
      }

      // Seed uptime from stored agent info if we haven't received an agent_info WS event yet.
      const hasLiveUptime = agentInfo[id]?.uptime_secs != null;
      if (agent.online && !hasLiveUptime && fallbackUptime[id] == null) {
        api
          .agentInfo(id)
          .then(({ info }) => {
            if (cancelled) return;
            const secs = info?.uptime_secs;
            if (typeof secs === "number" && secs >= 0) {
              setFallbackUptime((prev) =>
                prev[id] ? prev : { ...prev, [id]: { secs, receivedAtMs: Date.now() } },
              );
            }
          })
          .catch(() => { /* ignore */ });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [agents, liveStatus, agentInfo, fallbackLastWindow, fallbackUptime]);

  const agentsWithStatus: AgentCardItem[] = useMemo(() => {
    return Object.entries(agents).map(([id, agent]) => ({
      ...agent,
      liveStatus: liveStatus[id],
      agentInfo: agentInfo[id],
      agentInfoReceivedAtMs: agentInfoReceivedAtMs[id],
      fallbackLastWindow: fallbackLastWindow[id],
      fallbackUptimeSecs: fallbackUptime[id]?.secs,
      fallbackUptimeReceivedAtMs: fallbackUptime[id]?.receivedAtMs,
      internetBlocked: internetBlockedByAgent[id]?.blocked ?? null,
      internetBlockedSource: internetBlockedByAgent[id]?.source ?? null,
      appBlockEnabledCount: appBlockByAgent[id]?.enabledCount ?? null,
      appBlockExamples: appBlockByAgent[id]?.examples ?? null,
    }));
  }, [
    agents,
    liveStatus,
    agentInfo,
    agentInfoReceivedAtMs,
    fallbackLastWindow,
    fallbackUptime,
    internetBlockedByAgent,
    appBlockByAgent,
  ]);

  const cardDefinition = useMemo(
    () =>
      createCardDefinitions(
        onSelectAgent,
        onOpenScreen,
        (agentId) => setPowerModal({ agentId }),
        nowMs
      ),
    [onSelectAgent, onOpenScreen, nowMs]
  );

  const { items, filteredItemsCount, filterProps, collectionProps, paginationProps } = useCollection(
    agentsWithStatus,
    {
    filtering: {
      filteringFunction: (item, filteringText) => {
        const searchText = filteringText.toLowerCase();
        const detailsWindow = (item.liveStatus?.window || item.fallbackLastWindow || "").toLowerCase();
        const displayName = agentCardDisplayName(item).toLowerCase();
        const hostname = (item.agentInfo?.hostname || "").toLowerCase();
        const cfgName = (item.agentInfo?.config_agent_name || "").toLowerCase();

        const statusOk =
          statusFilter === "all"
            ? true
            : statusFilter === "connected"
              ? item.online
              : statusFilter === "disconnected"
                ? !item.online
                : item.online && item.liveStatus?.activity === "afk";

        if (!statusOk) return false;
        return (
          item.name.toLowerCase().includes(searchText) ||
          item.id.toLowerCase().includes(searchText) ||
          displayName.includes(searchText) ||
          cfgName.includes(searchText) ||
          hostname.includes(searchText) ||
          (detailsWindow.includes(searchText) ?? false)
        );
      },
    },
    sorting: {
      defaultState: {
        sortingColumn: {
          sortingField: "online",
        },
        isDescending: true,
      },
    },
    pagination: { pageSize },
    selection: {},
  });

  // Load internet policy state for currently visible cards (cached, best-effort).
  useEffect(() => {
    let cancelled = false;
    const visibleIds = items.map((i) => i.id);
    const now = Date.now();
    const needs = visibleIds.filter((id) => {
      const prev = internetBlockedByAgent[id];
      if (!prev) return true;
      // Refresh periodically so cards stay accurate if rules are edited.
      return now - prev.fetchedAtMs > 60_000;
    });
    if (needs.length === 0) return;

    const run = async () => {
      // Soft concurrency limit to avoid a thundering herd on first load.
      const batchSize = 6;
      for (let i = 0; i < needs.length; i += batchSize) {
        const batch = needs.slice(i, i + batchSize);
        const res = await Promise.allSettled(
          batch.map(async (id) => {
            const r = await api.agentInternetBlockedGet(id);
            return { id, blocked: Boolean(r.blocked), source: (r.source ?? null) as string | null };
          }),
        );
        if (cancelled) return;
        setInternetBlockedByAgent((prev) => {
          const next = { ...prev };
          for (const r of res) {
            if (r.status !== "fulfilled") continue;
            next[r.value.id] = {
              blocked: r.value.blocked,
              source: r.value.source,
              fetchedAtMs: Date.now(),
            };
          }
          return next;
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [items, internetBlockedByAgent]);

  // Load app-block rule summary for currently visible cards (cached, best-effort).
  useEffect(() => {
    let cancelled = false;
    const visibleIds = items.map((i) => i.id);
    const now = Date.now();
    const needs = visibleIds.filter((id) => {
      const prev = appBlockByAgent[id];
      if (!prev) return true;
      return now - prev.fetchedAtMs > 60_000;
    });
    if (needs.length === 0) return;

    const summarize = (rules: AppBlockRule[]) => {
      const enabled = rules.filter((r) => Boolean(r.enabled));
      const examples = enabled
        .map((r) => (r.name || r.exe_pattern || "").trim() || r.exe_pattern)
        .filter((s) => s && s.length <= 80);
      return { enabledCount: enabled.length, examples: Array.from(new Set(examples)).slice(0, 6) };
    };

    const run = async () => {
      const batchSize = 4;
      for (let i = 0; i < needs.length; i += batchSize) {
        const batch = needs.slice(i, i + batchSize);
        const res = await Promise.allSettled(
          batch.map(async (id) => {
            const r = await api.appBlockRulesList(id);
            return { id, ...summarize(r.rules ?? []) };
          }),
        );
        if (cancelled) return;
        setAppBlockByAgent((prev) => {
          const next = { ...prev };
          for (const r of res) {
            if (r.status !== "fulfilled") continue;
            next[r.value.id] = {
              enabledCount: r.value.enabledCount,
              examples: r.value.examples,
              fetchedAtMs: Date.now(),
            };
          }
          return next;
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [items, appBlockByAgent]);

  const selectedItems = collectionProps.selectedItems || [];
  const selectedOnlineCount = selectedItems.reduce(
    (acc, i) => acc + (agents[i.id]?.online ? 1 : 0),
    0,
  );
  const selectedOfflineCount = selectedItems.length - selectedOnlineCount;
  const selectedHasOnline = selectedOnlineCount > 0;
  const selectedHasOffline = selectedOfflineCount > 0;
  const modalAgent = powerModal?.agentId ? agents[powerModal.agentId] : null;
  const modalOnline = powerModal?.agentId ? Boolean(agents[powerModal.agentId]?.online) : false;
  const modalTitle = modalAgent?.name ?? powerModal?.agentId ?? "";

  return (
    <>
      <Cards
        {...collectionProps}
        variant="full-page"
        stickyHeader
        cardDefinition={cardDefinition}
        visibleSections={visibleSections}
        items={items}
        selectionType="multi"
        cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }, { minWidth: 900, cards: 3 }]}
        header={
          <Box padding={{ bottom: "m" }} className="sentinel-overview-cards-header">
            <FullPageHeader
              totalAgents={agentsWithStatus.length}
              onlineCount={agentsWithStatus.filter((agent) => agent.online).length}
              selectedCount={selectedItems.length}
              selectedHasOnline={selectedHasOnline}
              selectedHasOffline={selectedHasOffline}
              selectedOnlineCount={selectedOnlineCount}
              selectedOfflineCount={selectedOfflineCount}
              onRefresh={onRefresh}
              onWakeSelected={() => onBatchWake(selectedItems.filter((i) => !agents[i.id]?.online).map((i) => i.id))}
              onBulkScript={() => onBulkScript(selectedItems.map((item) => item.id))}
              onLockSelected={() => onBatchLock(selectedItems.filter((i) => agents[i.id]?.online).map((i) => i.id))}
              onRestartSelected={() => onBatchRestart(selectedItems.filter((i) => agents[i.id]?.online).map((i) => i.id))}
              onShutdownSelected={() => onBatchShutdown(selectedItems.filter((i) => agents[i.id]?.online).map((i) => i.id))}
              onDeleteSelected={
                onDeleteAgents
                  ? () => {
                      const ids = selectedItems.map((i) => i.id);
                      if (ids.length === 0) return;
                      if (
                        !confirm(
                          `Delete (forget) ${ids.length} agent${ids.length === 1 ? "" : "s"} from the server? This deletes stored telemetry and disconnects existing installs.`
                        )
                      ) {
                        return;
                      }
                      onDeleteAgents(ids);
                    }
                  : undefined
              }
              onBulkAddToGroup={
                onBulkAddToGroup
                  ? () => onBulkAddToGroup(selectedItems.map((item) => item.id))
                  : undefined
              }
              onAddAgent={onAddAgent}
            />
          </Box>
        }
        filter={
          <SpaceBetween size="s">
            <SegmentedControl
              label="Filters"
              selectedId={statusFilter}
              options={[
                { id: "all", text: "All" },
                { id: "connected", text: "Connected" },
                { id: "disconnected", text: "Disconnected" },
                { id: "afk", text: "AFK" },
              ]}
              onChange={({ detail }) =>
                setStatusFilter(detail.selectedId as typeof statusFilter)
              }
            />
            <TextFilter
              {...filterProps}
              countText={`${filteredItemsCount} matches`}
              filteringPlaceholder="Search agents…"
            />
          </SpaceBetween>
        }
        pagination={<Pagination {...paginationProps} />}
        empty={
          filterProps.filteringText || statusFilter !== "all" ? (
            <TableNoMatchState
              onClearFilter={() => {
                setStatusFilter("all");
                filterProps.onChange({
                  detail: { filteringText: "" },
                } as Parameters<typeof filterProps.onChange>[0])
              }}
            />
          ) : (
            <TableEmptyState
              title="No agents"
              subtitle="No agents are connected right now."
              actionText="Refresh"
              onActionClick={onRefresh}
            />
          )
        }
      />

      <Modal
        visible={Boolean(powerModal)}
        onDismiss={() => setPowerModal(null)}
        header="Power actions"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setPowerModal(null)}>
                Close
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Box variant="h3">{modalTitle || "Agent"}</Box>
            <StatusIndicator type={modalOnline ? "success" : "stopped"}>
              {modalOnline ? "Online" : "Offline"}
            </StatusIndicator>
          </SpaceBetween>

          {!powerModal?.agentId ? null : modalOnline ? (
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName="lock-private"
                onClick={() => {
                  const id = powerModal.agentId;
                  setPowerModal(null);
                  onBatchLock([id]);
                }}
              >
                Lock
              </Button>
              <Button
                iconName="redo"
                onClick={() => {
                  const id = powerModal.agentId;
                  setPowerModal(null);
                  onBatchRestart([id]);
                }}
              >
                Restart
              </Button>
              <Button
                iconName="close"
                variant="primary"
                onClick={() => {
                  const id = powerModal.agentId;
                  setPowerModal(null);
                  onBatchShutdown([id]);
                }}
              >
                Shutdown
              </Button>
            </SpaceBetween>
          ) : (
            <SpaceBetween size="s">
              <Box color="text-body-secondary">
                This agent is offline. You can send Wake-on-LAN if it’s configured on the machine and reachable on the LAN.
              </Box>
              <div>
                <Button
                  iconName="status-stopped"
                  variant="primary"
                  onClick={() => {
                    const id = powerModal.agentId;
                    setPowerModal(null);
                    onBatchWake([id]);
                  }}
                >
                  Wake on LAN
                </Button>
              </div>
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Modal>
    </>
  );
}
