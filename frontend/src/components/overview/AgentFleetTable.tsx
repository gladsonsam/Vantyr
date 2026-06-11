import { useEffect, useMemo, useState } from "react";
import {
  FileCode2,
  RefreshCw,
  Search,
  Trash2,
  Users,
  Zap,
  Filter,
  LayoutGrid,
  List,
  Power,
} from "lucide-react";
import type { Agent, AgentInfo, AgentLiveStatus, AppBlockRule } from "../../lib/types";
import { api } from "../../lib/api";
import { useServerVersionPayload } from "../../lib/serverVersionStore";
import {
  ConsoleButton,
  IconButton,
  SearchField,
  SegmentedFilter,
  type ConsoleStatus,
  type OsKind,
} from "../ui/console";
import { SortableTh, type SortKey } from "./SortableTh";
import { PowerActionsModal } from "./PowerActionsModal";
import { AgentCardGrid } from "./AgentCardGrid";
import { AgentTableRow } from "./AgentTableRow";
import type { FleetRow } from "./types";
import { normalizeVersion } from "./utils";

type StatusFilter = "all" | "connected" | "active" | "afk" | "offline" | "blocked" | "updates";

interface AgentFleetTableProps {
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
  onBulkAddToGroup?: (agentIds: string[]) => void;
  onAddAgent?: () => void;
  onDeleteAgents?: (agentIds: string[]) => void;
  /** Controlled view mode (from TopBar toggle) — if provided, hides internal view toggle */
  controlledViewMode?: "table" | "grid";
  onViewModeChange?: (mode: "table" | "grid") => void;
  /** Controlled search query (from TopBar search) — if provided, hides internal search */
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
  if (os.includes("linux")) return "linux";
  return "unknown";
}

function primaryIp(info: AgentInfo | null | undefined) {
  const adapters = info?.adapters ?? [];
  for (const adapter of adapters) {
    const ip = adapter.ips?.find((candidate) => candidate && !candidate.startsWith("127.") && candidate !== "::1");
    if (ip) return ip;
  }
  return "-";
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
  onBulkScript,
  onBatchLock,
  onBatchRestart,
  onBatchShutdown,
  onBulkAddToGroup,
  onAddAgent,
  onDeleteAgents,
  controlledViewMode,
  onViewModeChange,
  controlledQuery,
  onQueryChange,
}: AgentFleetTableProps) {
  const versionPayload = useServerVersionPayload();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [internalQuery, setInternalQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fallbackLastWindow, setFallbackLastWindow] = useState<Record<string, string>>({});
  const [fallbackUptime, setFallbackUptime] = useState<Record<string, { secs: number; receivedAtMs: number }>>({});
  const [internetBlockedByAgent, setInternetBlockedByAgent] = useState<
    Record<string, { blocked: boolean; source: string | null; fetchedAtMs: number }>
  >({});
  const [appBlockByAgent, setAppBlockByAgent] = useState<
    Record<string, { enabledCount: number; examples: string[]; fetchedAtMs: number }>
  >({});
  const [powerModal, setPowerModal] = useState<null | { agentId: string }>(null);
  const [internalViewMode, setInternalViewMode] = useState<"table" | "grid">("table");

  const query = controlledQuery !== undefined ? controlledQuery : internalQuery;
  const setQuery = onQueryChange ?? setInternalQuery;
  const viewMode = controlledViewMode !== undefined ? controlledViewMode : internalViewMode;
  const setViewMode = (mode: "table" | "grid") => {
    if (onViewModeChange) onViewModeChange(mode);
    else setInternalViewMode(mode);
  };
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => agents[id]));
  }, [agents]);

  useEffect(() => {
    let cancelled = false;

    for (const [id, agent] of Object.entries(agents)) {
      if (!liveStatus[id]?.window && fallbackLastWindow[id] == null) {
        api
          .windows(id, { limit: 1, offset: 0 })
          .then(({ rows }) => {
            if (cancelled) return;
            const title = rows[0]?.title;
            if (typeof title === "string" && title.trim() !== "") {
              setFallbackLastWindow((prev) => (prev[id] ? prev : { ...prev, [id]: title }));
            }
          })
          .catch(() => {});
      }

      if (agent.online && agentInfo[id]?.uptime_secs == null && fallbackUptime[id] == null) {
        api
          .agentInfo(id)
          .then(({ info }) => {
            if (cancelled) return;
            const secs = info?.uptime_secs;
            if (typeof secs === "number" && secs >= 0) {
              setFallbackUptime((prev) => (prev[id] ? prev : { ...prev, [id]: { secs, receivedAtMs: Date.now() } }));
            }
          })
          .catch(() => {});
      }
    }

    return () => {
      cancelled = true;
    };
  }, [agents, liveStatus, agentInfo, fallbackLastWindow, fallbackUptime]);

  const rows = useMemo<FleetRow[]>(() => {
    return Object.values(agents).map((agent) => {
      const id = agent.id;
      const info = agentInfo[id] ?? null;
      const status = liveStatus[id];
      const displayName = agent.name?.trim() || info?.config_agent_name?.trim() || info?.hostname?.trim() || id;
      const version = agent.agent_version ?? info?.agent_version ?? null;
      const idleSecs =
        status?.activity === "afk"
          ? status.idleSinceMs != null
            ? Math.max(0, Math.floor((nowMs - status.idleSinceMs) / 1000))
            : status.idleSecs
          : undefined;
      const liveUptimeBase = info?.uptime_secs ?? fallbackUptime[id]?.secs;
      const liveUptimeReceivedAt = agentInfoReceivedAtMs[id] ?? fallbackUptime[id]?.receivedAtMs ?? 0;
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
      const rowStatus: ConsoleStatus = internetBlocked ? "blocked" : isAfk ? "afk" : isActive ? "active" : agent.online ? "connected" : "offline";

      return {
        ...agent,
        appBlockEnabledCount: blockedApps,
        appBlockExamples: appBlockByAgent[id]?.examples ?? null,
        displayName,
        effectiveUptimeSecs,
        idleSecs,
        internetBlocked,
        internetBlockedSource: internetBlockedByAgent[id]?.source ?? null,
        ip: primaryIp(info),
        lastWindow: status?.window || fallbackLastWindow[id] || "-",
        liveStatus: status,
        os: osFromInfo(info),
        status: rowStatus,
        statusLabel: internetBlocked ? "Blocked" : isAfk ? "AFK" : isActive ? "Active" : agent.online ? "Connected" : "Offline",
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
    fallbackUptime,
    internetBlockedByAgent,
    liveStatus,
    nowMs,
    versionPayload?.latest_agent_version,
  ]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const statusRank: Record<ConsoleStatus, number> = {
      active: 5,
      connected: 4,
      ok: 4,
      afk: 3,
      blocked: 2,
      danger: 2,
      offline: 1,
    };

    const next = rows.filter((row) => {
      const statusOk =
        statusFilter === "all" ||
        (statusFilter === "connected" && row.online) ||
        (statusFilter === "active" && row.status === "active") ||
        (statusFilter === "afk" && row.status === "afk") ||
        (statusFilter === "offline" && !row.online) ||
        (statusFilter === "blocked" && (row.internetBlocked || (row.appBlockEnabledCount ?? 0) > 0)) ||
        (statusFilter === "updates" && row.updateNeeded);
      if (!statusOk) return false;
      if (!needle) return true;
      return [row.displayName, row.id, row.user, row.ip, row.lastWindow, row.liveStatus?.app, row.liveStatus?.url]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    next.sort((a, b) => {
      const dir = sortDesc ? -1 : 1;
      const value = (() => {
        if (sortKey === "status") return statusRank[a.status] - statusRank[b.status];
        if (sortKey === "agent") return a.displayName.localeCompare(b.displayName);
        if (sortKey === "activity") return (a.idleSecs ?? -1) - (b.idleSecs ?? -1);
        if (sortKey === "version") return (a.version ?? "").localeCompare(b.version ?? "");
        if (sortKey === "uptime") return (a.effectiveUptimeSecs ?? -1) - (b.effectiveUptimeSecs ?? -1);
        return a.lastWindow.localeCompare(b.lastWindow);
      })();
      return value * dir;
    });

    return next;
  }, [query, rows, sortDesc, sortKey, statusFilter]);

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

  const counts = useMemo(() => {
    return {
      all: rows.length,
      connected: rows.filter((row) => row.online).length,
      active: rows.filter((row) => row.status === "active").length,
      afk: rows.filter((row) => row.status === "afk").length,
      offline: rows.filter((row) => !row.online).length,
      blocked: rows.filter((row) => row.internetBlocked || (row.appBlockEnabledCount ?? 0) > 0).length,
      updates: rows.filter((row) => row.updateNeeded).length,
    };
  }, [rows]);

  const selectedRows = selectedIds.map((id) => agents[id]).filter(Boolean);
  const selectedOnlineIds = selectedRows.filter((agent) => agent.online).map((agent) => agent.id);
  const selectedOfflineIds = selectedRows.filter((agent) => !agent.online).map((agent) => agent.id);
  const allVisibleSelected = filteredRows.length > 0 && filteredRows.every((row) => selectedIds.includes(row.id));
  const modalRow = powerModal?.agentId ? (rows.find((row) => row.id === powerModal.agentId) ?? null) : null;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((value) => !value);
    } else {
      setSortKey(key);
      setSortDesc(key !== "agent" && key !== "lastWindow");
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const deleteSelected = () => {
    if (!onDeleteAgents || selectedIds.length === 0) return;
    if (
      !confirm(
        `Delete (forget) ${selectedIds.length} agent${selectedIds.length === 1 ? "" : "s"} from the server? This deletes stored telemetry and disconnects existing installs.`,
      )
    ) {
      return;
    }
    onDeleteAgents(selectedIds);
  };

  return (
    <section className="vantyr-fleet-table sx-console">
      <div className="vantyr-fleet-toolbar">
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {onQueryChange === undefined && (
            <SearchField label="Search fleet" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents, users, windows..." />
          )}
          <ConsoleButton
            icon={Filter}
            variant={statusFilter !== "all" ? "primary" : "ghost"}
            onClick={() => setShowFilters((prev) => !prev)}
          >
            Filters{statusFilter !== "all" ? `: ${statusFilter}` : ""}
          </ConsoleButton>
        </div>
        <div className="vantyr-fleet-toolbar__actions">
          {onViewModeChange === undefined && (
            <>
              <IconButton
                icon={List}
                label="Table view"
                accent={viewMode === "table"}
                onClick={() => setViewMode("table")}
              />
              <IconButton
                icon={LayoutGrid}
                label="Card view"
                accent={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
              />
            </>
          )}
          <ConsoleButton icon={RefreshCw} variant="ghost" onClick={onRefresh}>
            Refresh
          </ConsoleButton>
          {onAddAgent ? (
            <ConsoleButton icon={Zap} variant="primary" onClick={onAddAgent}>
              Enroll agent
            </ConsoleButton>
          ) : null}
        </div>
      </div>

      {showFilters ? (
        <div className="vantyr-fleet-filters-pane">
          <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--sx-text-dim)" }}>Filter by status:</div>
          <SegmentedFilter
            ariaLabel="Fleet status filters"
            value={statusFilter}
            onChange={(val) => setStatusFilter(val as StatusFilter)}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "connected", label: "Connected", count: counts.connected },
              { value: "active", label: "Active", count: counts.active },
              { value: "afk", label: "AFK", count: counts.afk },
              { value: "offline", label: "Offline", count: counts.offline },
              { value: "blocked", label: "Blocked", count: counts.blocked },
              { value: "updates", label: "Updates", count: counts.updates },
            ]}
          />
        </div>
      ) : null}

      {selectedIds.length > 0 ? (
        <div className="vantyr-fleet-bulkbar">
          <span className="sx-mono">{selectedIds.length} selected</span>
          <ConsoleButton icon={Zap} disabled={selectedOfflineIds.length === 0} onClick={() => onBatchWake(selectedOfflineIds)}>
            Wake
          </ConsoleButton>
          <ConsoleButton icon={FileCode2} onClick={() => onBulkScript(selectedIds)}>
            Script
          </ConsoleButton>
          <ConsoleButton icon={Power} disabled={selectedOnlineIds.length === 0} onClick={() => onBatchLock(selectedOnlineIds)}>
            Lock
          </ConsoleButton>
          <ConsoleButton icon={RefreshCw} disabled={selectedOnlineIds.length === 0} onClick={() => onBatchRestart(selectedOnlineIds)}>
            Restart
          </ConsoleButton>
          <ConsoleButton icon={Power} disabled={selectedOnlineIds.length === 0} variant="danger" onClick={() => onBatchShutdown(selectedOnlineIds)}>
            Shutdown
          </ConsoleButton>
          {onBulkAddToGroup ? (
            <ConsoleButton icon={Users} onClick={() => onBulkAddToGroup(selectedIds)}>
              Group
            </ConsoleButton>
          ) : null}
          {onDeleteAgents ? (
            <ConsoleButton icon={Trash2} variant="danger" onClick={deleteSelected}>
              Delete
            </ConsoleButton>
          ) : null}
        </div>
      ) : null}

      {viewMode === "table" ? (
        <div className="vantyr-fleet-table__frame">
          <table>
            <thead>
              <tr>
                <th className="is-select">
                  <input
                    type="checkbox"
                    aria-label="Select all visible agents"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelectedIds((prev) =>
                        allVisibleSelected
                          ? prev.filter((id) => !filteredRows.some((row) => row.id === id))
                          : Array.from(new Set([...prev, ...filteredRows.map((row) => row.id)])),
                      )
                    }
                  />
                </th>
                <SortableTh label="Agent" sortKey="agent" activeKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                <SortableTh label="Status" sortKey="status" activeKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                <SortableTh label="Activity" sortKey="activity" activeKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                <SortableTh label="Version" sortKey="version" activeKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                <SortableTh label="Uptime" sortKey="uptime" activeKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                <SortableTh label="Last window" sortKey="lastWindow" activeKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                <th className="is-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <AgentTableRow
                  key={row.id}
                  row={row}
                  selectedIds={selectedIds}
                  toggleSelected={toggleSelected}
                  onSelectAgent={onSelectAgent}
                  onOpenScreen={onOpenScreen}
                  setPowerModal={setPowerModal}
                />
              ))}
            </tbody>
          </table>

          {filteredRows.length === 0 ? (
            <div className="vantyr-fleet-empty">
              <Search size={18} aria-hidden="true" />
              <strong>No matching agents</strong>
              <span>Clear search or status filters to return to the full fleet.</span>
            </div>
          ) : null}
        </div>
      ) : (
        <AgentCardGrid
          filteredRows={filteredRows}
          selectedIds={selectedIds}
          toggleSelected={toggleSelected}
          onSelectAgent={onSelectAgent}
          onOpenScreen={onOpenScreen}
          setPowerModal={setPowerModal}
          latestAgentVersion={versionPayload?.latest_agent_version}
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
      />
    </section>
  );
}
