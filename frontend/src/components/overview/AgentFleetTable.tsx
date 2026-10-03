import { useEffect, useMemo, useState, useRef } from "react";
import type { Agent, AgentInfo, AgentLiveStatus, AppBlockRule, TabKey } from "../../lib/types";
import { sortFleet, useFleetSort, type FleetSort } from "../../lib/fleetSort";
import { api } from "../../lib/api";
import { primaryIp } from "../../lib/agentNetwork";
import { useServerVersionPayload } from "../../lib/serverVersionStore";
import type { ConsoleStatus, OsKind } from "../ui/console";
import { Modal, Box, SpaceBetween, Button } from "../ui/console";
import { PowerActionsModal } from "./PowerActionsModal";
import { AgentCardGrid } from "./AgentCardGrid";
import { AgentListView } from "./AgentListView";
import type { FleetRow } from "./types";
import { normalizeVersion } from "./utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";

interface AgentFleetTableProps {
  agents: Record<string, Agent>;
  liveStatus: Record<string, AgentLiveStatus>;
  agentInfo: Record<string, AgentInfo | null>;
  agentInfoReceivedAtMs: Record<string, number>;
  onSelectAgent: (agentId: string, tab?: TabKey, scroll?: boolean) => void;
  onOpenScreen: (agentId: string) => void;
  onRefresh: () => void;
  onBatchWake: (agentIds: string[]) => void;
  onBulkScript: (agentIds: string[]) => void;
  onBatchLock: (agentIds: string[]) => void;
  onBatchRestart: (agentIds: string[]) => void;
  onBatchShutdown: (agentIds: string[]) => void;
  onBulkAddToGroup?: (agentIds: string[]) => void;
  onAddAgent?: () => void;
  onDeleteAgents?: (agentIds: string[]) => Promise<void>;
  canOperate?: boolean;
  /** Controlled view mode (from TopBar toggle) */
  controlledViewMode?: "table" | "grid";
  onViewModeChange?: (mode: "table" | "grid") => void;
  /** Controlled search query (from TopBar search) */
  controlledQuery?: string;
  onQueryChange?: (q: string) => void;
}

function isUpdateNeeded(current: string | null, latest: string | null | undefined) {
  const a = normalizeVersion(current);
  const b = normalizeVersion(latest);
  return Boolean(a && b && a !== b);
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

export function AgentFleetTable({
  agents,
  liveStatus,
  agentInfo,
  agentInfoReceivedAtMs,
  onSelectAgent,
  onOpenScreen,
  onRefresh,
  onBatchWake,
  onBatchLock,
  onBatchRestart,
  onBatchShutdown,
  onDeleteAgents,
  canOperate = true,
  controlledViewMode,
  controlledQuery,
}: AgentFleetTableProps) {
  const versionPayload = useServerVersionPayload();
  // The dense list view uses fixed-pixel columns that overflow phones; fall back
  // to the (already responsive) card grid on narrow screens.
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fallbackLastWindow, setFallbackLastWindow] = useState<Record<string, { title: string; app?: string }>>({});
  const [fallbackInfo, setFallbackInfo] = useState<Record<string, { info: AgentInfo; receivedAtMs: number }>>({});
  const [internetBlockedByAgent, setInternetBlockedByAgent] = useState<
    Record<string, { blocked: boolean; source: string | null; fetchedAtMs: number }>
  >({});
  const [appBlockByAgent, setAppBlockByAgent] = useState<
    Record<string, { enabledCount: number; examples: string[]; fetchedAtMs: number }>
  >({});
  const [powerModal, setPowerModal] = useState<null | { agentId: string }>(null);
  // Bulk-delete selection (admin only; visible when `onDeleteAgents` is provided).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const deleteInFlight = useRef(false);
  const [fleetSort, setFleetSort] = useFleetSort();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const query = controlledQuery ?? "";
  const viewMode = controlledViewMode ?? "grid";

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    for (const [id] of Object.entries(agents)) {
      if (!liveStatus[id]?.window && fallbackLastWindow[id] == null) {
        api
          .windows(id, { limit: 1, offset: 0 })
          .then(({ rows }) => {
            if (cancelled) return;
            const row = rows[0];
            const title = row?.title;
            const app = row?.app;
            if (typeof title === "string" && title.trim() !== "") {
              setFallbackLastWindow((prev) => (prev[id] ? prev : { ...prev, [id]: { title, app: typeof app === "string" ? app : undefined } }));
            }
          })
          .catch(() => {});
      }

      if (agentInfo[id] == null && fallbackInfo[id] == null) {
        api
          .agentInfo(id)
          .then(({ info }) => {
            if (cancelled) return;
            if (info) {
              setFallbackInfo((prev) => (prev[id] ? prev : { ...prev, [id]: { info, receivedAtMs: Date.now() } }));
            }
          })
          .catch(() => {});
      }
    }

    return () => {
      cancelled = true;
    };
  }, [agents, liveStatus, agentInfo, fallbackLastWindow, fallbackInfo]);

  const rows = useMemo<FleetRow[]>(() => {
    return Object.values(agents).map((agent) => {
      const id = agent.id;
      const info = agentInfo[id] ?? fallbackInfo[id]?.info ?? null;
      const status = liveStatus[id];
      const displayName = agent.name?.trim() || info?.config_agent_name?.trim() || info?.hostname?.trim() || id;
      const version = agent.agent_version ?? info?.agent_version ?? null;
      const idleSecs =
        status?.activity === "afk"
          ? status.idleSinceMs != null
            ? Math.max(0, Math.floor((nowMs - status.idleSinceMs) / 1000))
            : status.idleSecs
          : undefined;
      const liveUptimeBase = info?.uptime_secs;
      const liveUptimeReceivedAt = agentInfoReceivedAtMs[id] ?? fallbackInfo[id]?.receivedAtMs ?? 0;
      const effectiveUptimeSecs =
        liveUptimeBase == null
          ? undefined
          : agent.online && liveUptimeReceivedAt
            ? liveUptimeBase + Math.max(0, Math.floor((nowMs - liveUptimeReceivedAt) / 1000))
            : liveUptimeBase;
      const internetBlocked = internetBlockedByAgent[id]?.blocked ?? null;
      const blockedApps = appBlockByAgent[id]?.enabledCount ?? null;
      const isAfk = agent.online && status?.activity === "afk";
      const isActive = agent.online && status?.activity === "active";
      const rowStatus: ConsoleStatus = isAfk ? "afk" : isActive ? "active" : agent.online ? "connected" : "offline";

      const effectiveLiveStatus = {
        ...status,
        app: status?.app || fallbackLastWindow[id]?.app,
        window: status?.window || fallbackLastWindow[id]?.title,
      };

      return {
        ...agent,
        appBlockEnabledCount: blockedApps,
        appBlockExamples: appBlockByAgent[id]?.examples ?? null,
        displayName,
        effectiveUptimeSecs,
        idleSecs,
        internetBlocked,
        internetBlockedSource: internetBlockedByAgent[id]?.source ?? null,
        ip: primaryIp(info) ?? "-",
        lastWindow: effectiveLiveStatus.window || "-",
        liveStatus: effectiveLiveStatus,
        os: osFromInfo(info),
        status: rowStatus,
        statusLabel: isAfk ? "AFK" : isActive ? "Active" : agent.online ? "Connected" : "Offline",
        user: info?.current_user || "-",
        version,
        updateNeeded: isUpdateNeeded(version, versionPayload?.latest_agent_version),
      };
    });
  }, [
    agents,
    agentInfo,
    agentInfoReceivedAtMs,
    appBlockByAgent,
    fallbackLastWindow,
    fallbackInfo,
    internetBlockedByAgent,
    liveStatus,
    nowMs,
    versionPayload?.latest_agent_version,
  ]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const next = rows.filter((row) => {
      if (!needle) return true;
      return [row.displayName, row.id, row.user, row.ip, row.lastWindow, row.liveStatus?.app, row.liveStatus?.url]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    return sortFleet(next, fleetSort);
  }, [query, rows, fleetSort]);

  useEffect(() => {
    let cancelled = false;
    const visibleIds = filteredRows.slice(0, 36).map((row) => row.id);
    const now = Date.now();
    const needsInternet = visibleIds.filter((id) => {
      const prev = internetBlockedByAgent[id];
      return !prev || now - prev.fetchedAtMs > 60_000;
    });
    const needsApps = visibleIds.filter((id) => {
      const prev = appBlockByAgent[id];
      return !prev || now - prev.fetchedAtMs > 60_000;
    });

    const summarize = (rules: AppBlockRule[]) => {
      const enabled = rules.filter((rule) => Boolean(rule.enabled));
      const examples = enabled
        .map((rule) => (rule.name || rule.exe_pattern || "").trim() || rule.exe_pattern)
        .filter((name) => name && name.length <= 80);
      return { enabledCount: enabled.length, examples: Array.from(new Set(examples)).slice(0, 6) };
    };

    const run = async () => {
      const internet = await Promise.allSettled(
        needsInternet.map(async (id) => {
          const res = await api.agentInternetBlockedGet(id);
          return { id, blocked: Boolean(res.blocked), source: (res.source ?? null) as string | null };
        }),
      );
      if (!cancelled && internet.length > 0) {
        setInternetBlockedByAgent((prev) => {
          const next = { ...prev };
          for (const result of internet) {
            if (result.status === "fulfilled") {
              next[result.value.id] = { ...result.value, fetchedAtMs: Date.now() };
            }
          }
          return next;
        });
      }

      const apps = await Promise.allSettled(
        needsApps.map(async (id) => {
          const res = await api.appBlockRulesList(id);
          return { id, ...summarize(res.rules ?? []) };
        }),
      );
      if (!cancelled && apps.length > 0) {
        setAppBlockByAgent((prev) => {
          const next = { ...prev };
          for (const result of apps) {
            if (result.status === "fulfilled") {
              next[result.value.id] = {
                enabledCount: result.value.enabledCount,
                examples: result.value.examples,
                fetchedAtMs: Date.now(),
              };
            }
          }
          return next;
        });
      }
    };

    if (needsInternet.length > 0 || needsApps.length > 0) void run();
    return () => {
      cancelled = true;
    };
  }, [filteredRows, internetBlockedByAgent, appBlockByAgent]);

  const modalRow = powerModal?.agentId ? (rows.find((row) => row.id === powerModal.agentId) ?? null) : null;

  const canDelete = typeof onDeleteAgents === "function";
  const selectedIds = useMemo(() => [...selected], [selected]);

  // Drop ids removed elsewhere; filtering must preserve selection.
  useEffect(() => {
    if (deleting) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(Object.keys(agents));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [agents, deleting]);

  const toggleSelect = (id: string) => {
    if (deleting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(filteredRows.map((row) => row.id)));
  };

  const requestDelete = (ids: string[]) => {
    if (deleteInFlight.current) return;
    setDeleteError(null);
    setDeleteIds(ids);
  };

  const confirmBulkDelete = async () => {
    if (!onDeleteAgents || !deleteIds?.length || deleteInFlight.current) return;
    const ids = [...deleteIds];
    deleteInFlight.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteAgents(ids);
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      setDeleteIds(null);
      setPowerModal(null);
      onRefresh();
    } catch (e) {
      setDeleteError(String((e as { message?: string })?.message ?? e));
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  };
  const removalIds = deleteIds ?? [];

  return (
    <>
      <div className="fleet-sort-toolbar" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "12px 24px 0", color: "var(--tx-2)", fontSize: 12.5 }}>
        <label>Sort devices {" "}
          <select style={{ padding: "6px 9px", borderRadius: 8, background: "var(--card-2)", color: "var(--tx)", border: "1px solid var(--line-2)", fontSize: 12.5 }} aria-label="Sort devices" value={fleetSort.key} onChange={(e) => setFleetSort({ ...fleetSort, key: e.target.value as FleetSort["key"] })}>
            <option value="connectivity">Connectivity, then name</option>
            <option value="name">Name</option>
            <option value="last_seen">Last seen</option>
            <option value="first_seen">Date added</option>
            <option value="agent_version">Agent version</option>
          </select>
        </label>
        <label>Direction {" "}
          <select style={{ padding: "6px 9px", borderRadius: 8, background: "var(--card-2)", color: "var(--tx)", border: "1px solid var(--line-2)", fontSize: 12.5 }} aria-label="Sort direction" value={fleetSort.direction} onChange={(e) => setFleetSort({ ...fleetSort, direction: e.target.value as "asc" | "desc" })}>
            <option value="asc">{fleetSort.key === "connectivity" ? "Online first, A–Z" : fleetSort.key === "last_seen" || fleetSort.key === "first_seen" ? "Oldest first" : fleetSort.key === "agent_version" ? "Lowest first" : "A–Z"}</option>
            <option value="desc">{fleetSort.key === "connectivity" ? "Offline first, Z–A" : fleetSort.key === "last_seen" || fleetSort.key === "first_seen" ? "Newest first" : fleetSort.key === "agent_version" ? "Highest first" : "Z–A"}</option>
          </select>
        </label>
      </div>
      {canDelete && (
        <div className="fleet-selection-toolbar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 24px 0",
            fontSize: 12.5,
            color: "var(--tx-3)",
          }}
        >
          <span>
            {selectedIds.length > 0
              ? `${selectedIds.length} selected`
              : `${filteredRows.length} agent${filteredRows.length === 1 ? "" : "s"}`}
          </span>
          {filteredRows.length > 0 && (
            <>
              <button
                type="button"
                disabled={deleting}
                onClick={selectAllVisible}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--tx-2)",
                  fontSize: 12.5,
                  // Keep a 24px min target height for touch; `margin` gives the
                  // visual spacing without inflating the underline box.
                  minHeight: 24,
                  padding: "0 4px",
                  textDecoration: "underline",
                }}
              >
                Select all
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setSelected(new Set())}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--tx-2)",
                  fontSize: 12.5,
                  minHeight: 24,
                  padding: "0 4px",
                  textDecoration: "underline",
                }}
              >
                Clear
              </button>
            </>
          )}
          <div style={{ flex: 1 }} />
          {deleteError && (
            <span style={{ color: "var(--red)", fontSize: 12 }}>{deleteError}</span>
          )}
          <button
            type="button"
            disabled={selectedIds.length === 0 || deleting}
            onClick={() => requestDelete(selectedIds)}
            title="Remove selected devices"
            style={{
              padding: "7px 14px",
              borderRadius: 9,
              border: "1px solid var(--red)",
              background: "transparent",
              color: "var(--red)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: selectedIds.length === 0 || deleting ? "not-allowed" : "pointer",
              opacity: selectedIds.length === 0 || deleting ? 0.45 : 1,
            }}
          >
            {deleting ? "Removing…" : `Remove devices${selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}`}
          </button>
        </div>
      )}
      {viewMode === "table" && !isMobile ? (
        <AgentListView
          filteredRows={filteredRows}
          onSelectAgent={onSelectAgent}
          onOpenScreen={onOpenScreen}
          setPowerModal={setPowerModal}
          latestAgentVersion={versionPayload?.latest_agent_version}
          onRemoveDevice={canDelete ? (id) => requestDelete([id]) : undefined}
          removalBusy={deleting}
          showSelection={canDelete}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
        />
      ) : (
        <AgentCardGrid
          filteredRows={filteredRows}
          onSelectAgent={onSelectAgent}
          onOpenScreen={onOpenScreen}
          setPowerModal={setPowerModal}
          latestAgentVersion={versionPayload?.latest_agent_version}
          onRemoveDevice={canDelete ? (id) => requestDelete([id]) : undefined}
          removalBusy={deleting}
          showSelection={canDelete}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
        />
      )}

      <PowerActionsModal
        visible={Boolean(powerModal)}
        onDismiss={() => setPowerModal(null)}
        modalRow={modalRow}
        onBatchWake={onBatchWake}
        onBatchLock={onBatchLock}
        onBatchRestart={onBatchRestart}
        onBatchShutdown={onBatchShutdown}
        canOperate={canOperate}
        onDeleteAgent={canDelete ? (id) => { setPowerModal(null); requestDelete([id]); } : undefined}
        deleteBusy={deleting}
      />

      <Modal
        visible={deleteIds !== null}
        onDismiss={() => (deleting ? undefined : setDeleteIds(null))}
        header={`Remove ${removalIds.length} device${removalIds.length === 1 ? "" : "s"}?`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setDeleteIds(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="primary" loading={deleting} onClick={() => void confirmBulkDelete()}>
                Remove devices
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {deleteError && <div role="alert" style={{ color: "var(--red)", marginBottom: 12 }}>{deleteError}</div>}
        {(() => {
          const onlineCount = removalIds.filter((id) => agents[id]?.online).length;
          const names = removalIds
            .map((id) => rows.find((row) => row.id === id)?.displayName || id)
            .slice(0, 5);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                This permanently removes {removalIds.length === 1 ? "this agent" : `these ${removalIds.length} agents`} from
                the server, including {removalIds.length === 1 ? "its" : "their"} telemetry history.
                {names.length > 0 && (
                  <>
                    {" "}Affected: <strong>{names.join(", ")}</strong>
                    {removalIds.length > names.length && <> and {removalIds.length - names.length} more</>}.
                  </>
                )}
              </div>
              {onlineCount > 0 && (
                <div>
                  {onlineCount} of {removalIds.length === 1 ? "them is" : "them are"} currently online and will be
                  disconnected.
                </div>
              )}
              <div>
                Deleted agents stop reconnecting and show an error until they are re-enrolled. This cannot be undone.
              </div>
            </div>
          );
        })()}
      </Modal>
    </>
  );
}
