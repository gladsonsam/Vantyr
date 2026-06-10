import { useEffect, useMemo, useState } from "react";
import { Modal, Box, SpaceBetween, Button } from "../ui/console";
import clsx from "clsx";
import {
  ChevronDown,
  Clock,
  FileCode2,
  MonitorPlay,
  MoreHorizontal,
  MousePointer2,
  Power,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Users,
  AppWindow,
  Zap,
  Filter,
  LayoutGrid,
  List,
} from "lucide-react";
import type { Agent, AgentInfo, AgentLiveStatus, AppBlockRule } from "../../lib/types";
import { api } from "../../lib/api";
import { useServerVersionPayload } from "../../lib/serverVersionStore";
import {
  ConsoleButton,
  IconButton,
  OsBadge,
  SearchField,
  SegmentedFilter,
  StatusPill,
  type ConsoleStatus,
  type OsKind,
} from "../ui/console";

type StatusFilter = "all" | "connected" | "active" | "afk" | "offline" | "blocked" | "updates";
type SortKey = "status" | "agent" | "activity" | "version" | "uptime" | "lastWindow";

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
}

interface FleetRow extends Agent {
  appBlockEnabledCount: number | null;
  appBlockExamples: string[] | null;
  displayName: string;
  effectiveUptimeSecs?: number;
  idleSecs?: number;
  internetBlocked: boolean | null;
  internetBlockedSource: string | null;
  ip: string;
  lastWindow: string;
  liveStatus?: AgentLiveStatus;
  os: OsKind;
  status: ConsoleStatus;
  statusLabel: string;
  user: string;
  version: string | null;
  updateNeeded: boolean;
}

function formatUptime(secs?: number) {
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

function normalizeVersion(version: string | null | undefined) {
  return (version ?? "").trim().replace(/^v/i, "");
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
}: AgentFleetTableProps) {
  const versionPayload = useServerVersionPayload();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
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
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
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
  const modalRow = powerModal?.agentId ? rows.find((row) => row.id === powerModal.agentId) : null;

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

  const getStatusDotColor = (status: ConsoleStatus) => {
    switch (status) {
      case "active":
        return "var(--sx-success, #10b981)";
      case "connected":
      case "ok":
        return "var(--sx-accent, #3b82f6)";
      case "afk":
        return "var(--sx-warning, #f59e0b)";
      case "blocked":
      case "danger":
        return "var(--sx-danger, #ef4444)";
      case "offline":
      default:
        return "var(--sx-text-muted, #6b7280)";
    }
  };

  return (
    <section className="vantyr-fleet-table sx-console">
      <div className="vantyr-fleet-toolbar">
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <SearchField label="Search fleet" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents, users, windows..." />
          <ConsoleButton
            icon={Filter}
            variant={statusFilter !== "all" ? "primary" : "ghost"}
            onClick={() => setShowFilters((prev) => !prev)}
          >
            Filters{statusFilter !== "all" ? `: ${statusFilter}` : ""}
          </ConsoleButton>
        </div>
        <div className="vantyr-fleet-toolbar__actions">
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
                <tr key={row.id} className={clsx(!row.online && "is-offline")}>
                  <td className="is-select">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.displayName}`}
                      checked={selectedIds.includes(row.id)}
                      onChange={() => toggleSelected(row.id)}
                    />
                  </td>
                  <td className="is-agent">
                    <button type="button" className="vantyr-fleet-agent" onClick={() => onSelectAgent(row.id)}>
                      <OsBadge os={row.os} />
                      <span className="vantyr-fleet-agent__copy">
                        <span className="vantyr-fleet-agent__name sx-mono">{row.displayName}</span>
                        <span className="vantyr-fleet-agent__meta sx-mono">
                          {row.user} · {row.ip}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td>
                    <StatusPill status={row.status} pulse={row.status === "active"}>
                      {row.statusLabel}
                    </StatusPill>
                  </td>
                  <td>
                    {row.online ? (
                      <div className="vantyr-fleet-activity">
                        <span className="vantyr-fleet-activity__bar">
                          <span style={{ width: `${row.status === "afk" ? 24 : 68}%` }} />
                        </span>
                        <span className="sx-mono">{row.status === "afk" ? formatUptime(row.idleSecs) : "Live"}</span>
                      </div>
                    ) : (
                      <span className="vantyr-fleet-muted sx-mono">-</span>
                    )}
                  </td>
                  <td>
                    <div className="vantyr-fleet-version">
                      <span className="sx-mono">{row.version ? `v${normalizeVersion(row.version)}` : "-"}</span>
                      {row.updateNeeded ? <span className="vantyr-fleet-update">update</span> : null}
                    </div>
                  </td>
                  <td>
                    <span className="sx-mono">{row.online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}</span>
                  </td>
                  <td className="is-window">
                    <div className="vantyr-fleet-window">
                      <AppWindow size={14} aria-hidden="true" />
                      <span>{row.lastWindow}</span>
                    </div>
                    {row.internetBlocked || (row.appBlockEnabledCount ?? 0) > 0 ? (
                      <div className="vantyr-fleet-blocks">
                        {row.internetBlocked ? (
                          <span title={row.internetBlockedSource ? `Blocked by: ${row.internetBlockedSource}` : "Internet blocked"}>
                            <ShieldAlert size={12} /> Internet
                          </span>
                        ) : null}
                        {(row.appBlockEnabledCount ?? 0) > 0 ? (
                          <span title={row.appBlockExamples?.join(", ") || "App block rules enabled"}>
                            <ShieldAlert size={12} /> {row.appBlockEnabledCount} apps
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="is-actions">
                    <div className="vantyr-fleet-row-actions">
                      <IconButton icon={MonitorPlay} label="Open live screen" accent disabled={!row.online} onClick={() => onOpenScreen(row.id)} />
                      <IconButton icon={MousePointer2} label="Open remote control" accent disabled={!row.online} onClick={() => onSelectAgent(row.id)} />
                      <IconButton icon={Clock} label="Open activity" onClick={() => onSelectAgent(row.id)} />
                      <IconButton icon={MoreHorizontal} label="Power actions" onClick={() => setPowerModal({ agentId: row.id })} />
                    </div>
                  </td>
                </tr>
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
        <div className="vantyr-fleet-grid">
          {filteredRows.map((row) => (
            <div key={row.id} className={clsx("vantyr-fleet-card", !row.online && "is-offline")} style={{
              borderRadius: 'var(--sx-radius-lg, 12px)',
              border: '1px solid var(--sx-border, #262930)',
              background: 'var(--sx-surface, #131418)',
              padding: '16px',
              boxShadow: 'var(--sx-shadow, 0 4px 20px rgba(0,0,0,0.15))',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              position: 'relative',
              opacity: row.online ? 1 : 0.55,
              transition: 'border-color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease',
            }}>
              {/* head */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="checkbox"
                  aria-label={`Select ${row.displayName}`}
                  checked={selectedIds.includes(row.id)}
                  onChange={() => toggleSelected(row.id)}
                  style={{ marginRight: -2 }}
                />
                <OsBadge os={row.os} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button type="button" className="vantyr-fleet-card__name sx-mono" onClick={() => onSelectAgent(row.id)} style={{
                      fontSize: '15px', fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      background: 'none', border: 'none', padding: 0, color: 'var(--sx-text, #eceef1)', cursor: 'pointer', textAlign: 'left', width: '100%'
                    }}>
                      {row.displayName}
                    </button>
                    {row.updateNeeded && (
                      <span title="Update available" style={{ color: 'var(--sx-warning, #f59e0b)', display: 'flex', flexShrink: 0 }}>
                        <ShieldAlert size={14} />
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: getStatusDotColor(row.status),
                      boxShadow: row.status === 'active' ? '0 0 8px var(--sx-success, #10b981)' : 'none'
                    }} className={clsx(row.status === 'active' && 'pulse')} />
                    <span style={{ fontSize: '12px', fontWeight: 600, color: row.status === 'offline' ? 'var(--sx-text-muted, #6b7280)' : 'var(--sx-text, #eceef1)', whiteSpace: 'nowrap' }}>
                      {row.statusLabel}
                    </span>
                  </div>
                </div>
                {/* User & IP badge */}
                <div className="sx-mono" style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', textAlign: 'right', flexShrink: 0 }}>
                  <div>{row.user}</div>
                  <div>{row.ip}</div>
                </div>
              </div>

              {/* meta grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 14px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', fontWeight: 500, marginBottom: 3 }}>Version</div>
                  <div className="sx-mono" style={{ fontSize: '12.5px', color: 'var(--sx-text, #eceef1)', fontWeight: 500 }}>
                    {row.version ? `v${normalizeVersion(row.version)}` : "-"}
                    {row.updateNeeded && versionPayload?.latest_agent_version && (
                      <span style={{ color: 'var(--sx-warning, #f59e0b)' }}> → v{normalizeVersion(versionPayload.latest_agent_version)}</span>
                    )}
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', fontWeight: 500, marginBottom: 3 }}>
                    {row.online ? 'Uptime' : 'Last seen'}
                  </div>
                  <div className="sx-mono" style={{ fontSize: '12.5px', color: 'var(--sx-text, #eceef1)', fontWeight: 500 }}>
                    {row.online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}
                  </div>
                </div>
                <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
                  <div style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', fontWeight: 500, marginBottom: 3 }}>Last window</div>
                  <div style={{ fontSize: '12.5px', color: 'var(--sx-text, #eceef1)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AppWindow size={14} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--sx-text-dim, #7a7e85)' }} />
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }} title={row.lastWindow}>
                      {row.lastWindow}
                    </span>
                  </div>
                </div>
              </div>

              {/* blocks if any */}
              {(row.internetBlocked || (row.appBlockEnabledCount ?? 0) > 0) && (
                <div style={{ display: 'flex', gap: 8, padding: '4px 8px', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.1)', marginTop: -4 }}>
                  {row.internetBlocked && (
                    <span title={row.internetBlockedSource ? `Blocked by: ${row.internetBlockedSource}` : "Internet blocked"} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '11px', color: 'var(--sx-danger, #ef4444)' }}>
                      <ShieldAlert size={12} /> Internet Blocked
                    </span>
                  )}
                  {(row.appBlockEnabledCount ?? 0) > 0 && (
                    <span title={row.appBlockExamples?.join(", ") || "App block rules enabled"} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '11px', color: 'var(--sx-danger, #ef4444)' }}>
                      <ShieldAlert size={12} /> {row.appBlockEnabledCount} App Block{row.appBlockEnabledCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              )}

              {/* action row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 13, borderTop: '1px solid var(--sx-border, #262930)', marginTop: 'auto' }}>
                <span className="sx-mono" style={{ fontSize: '11.5px', color: 'var(--sx-text-dim, #7a7e85)' }}>
                  {row.online ? (row.status === "afk" ? `${formatUptime(row.idleSecs)} idle` : "Live") : "—"}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <IconButton icon={MonitorPlay} label="Open live screen" accent disabled={!row.online} onClick={() => onOpenScreen(row.id)} />
                  <IconButton icon={MousePointer2} label="Open remote control" accent disabled={!row.online} onClick={() => onSelectAgent(row.id)} />
                  <IconButton icon={Clock} label="Open activity" onClick={() => onSelectAgent(row.id)} />
                  <IconButton icon={MoreHorizontal} label="Power actions" onClick={() => setPowerModal({ agentId: row.id })} />
                </div>
              </div>
            </div>
          ))}

          {filteredRows.length === 0 ? (
            <div className="vantyr-fleet-empty" style={{ gridColumn: "1 / -1" }}>
              <Search size={18} aria-hidden="true" />
              <strong>No matching agents</strong>
              <span>Clear search or status filters to return to the full fleet.</span>
            </div>
          ) : null}
        </div>
      )}

      <Modal
        visible={Boolean(powerModal)}
        onDismiss={() => setPowerModal(null)}
        header="Power actions"
        footer={
          <Box float="right">
            <Button variant="link" onClick={() => setPowerModal(null)}>
              Close
            </Button>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <div className="vantyr-power-modal-head">
            <strong>{modalRow?.displayName ?? "Agent"}</strong>
            {modalRow ? <StatusPill status={modalRow.status}>{modalRow.statusLabel}</StatusPill> : null}
          </div>

          {modalRow?.online ? (
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName="lock-private"
                onClick={() => {
                  if (!modalRow) return;
                  setPowerModal(null);
                  onBatchLock([modalRow.id]);
                }}
              >
                Lock
              </Button>
              <Button
                iconName="redo"
                onClick={() => {
                  if (!modalRow) return;
                  setPowerModal(null);
                  onBatchRestart([modalRow.id]);
                }}
              >
                Restart
              </Button>
              <Button
                iconName="close"
                variant="primary"
                onClick={() => {
                  if (!modalRow) return;
                  setPowerModal(null);
                  onBatchShutdown([modalRow.id]);
                }}
              >
                Shutdown
              </Button>
            </SpaceBetween>
          ) : (
            <SpaceBetween size="s">
              <Box color="text-body-secondary">This agent is offline. Wake-on-LAN is available when configured and reachable on the LAN.</Box>
              <div>
                <Button
                  iconName="status-stopped"
                  variant="primary"
                  onClick={() => {
                    if (!modalRow) return;
                    setPowerModal(null);
                    onBatchWake([modalRow.id]);
                  }}
                >
                  Wake on LAN
                </Button>
              </div>
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Modal>
    </section>
  );
}

function SortableTh({
  label,
  sortKey,
  activeKey,
  desc,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th>
      <button type="button" className={clsx("vantyr-fleet-th", active && "is-active")} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        {active ? <ChevronDown size={13} className={clsx(!desc && "is-asc")} aria-hidden="true" /> : null}
      </button>
    </th>
  );
}
