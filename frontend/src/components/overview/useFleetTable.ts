import { useFleetPreferences, type FleetStatusFilter, type SavedFleetView } from "@/lib/fleetPreferences";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "@/api/types";
import type { TabKey } from "@/lib/agentTabNav";
import { sortFleet, useFleetSort } from "@/lib/fleetSort";
import { useFleetSummary } from "@/hooks/useFleetSummary";
import { primaryIp } from "@/lib/agentNetwork";
import { useServerVersionPayload } from "@/api/serverVersionStore";
import type { OsKind } from "@/components/common/OsBadge";
import type { FleetStatus } from "./types";
import type { FleetRow } from "./types";
import { normalizeVersion } from "./utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/**
 * Fleet overview state for the grid and table views: row enrichment, filters,
 * saved views, favorites, selection and the removal flow.
 */
export interface FleetTableProps {
  preferenceScope?: string | null;
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

export function useFleetTable({
  preferenceScope = null,
  onQueryChange,
  onViewModeChange,
  agents,
  liveStatus,
  agentInfo,
  agentInfoReceivedAtMs,
  onRefresh,
  onDeleteAgents,
  controlledViewMode,
  controlledQuery,
}: FleetTableProps) {
  const versionPayload = useServerVersionPayload();
  // The dense list view uses fixed-pixel columns that overflow phones; fall back
  // to the (already responsive) card grid on narrow screens.
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const enrichment = useFleetSummary(Object.keys(agents), preferenceScope);
  const [powerModal, setPowerModal] = useState<null | { agentId: string }>(null);
  // Bulk-delete selection (admin only; visible when `onDeleteAgents` is provided).
  const [selection, setSelection] = useState<{ scope: string | null; ids: Set<string> }>({ scope: preferenceScope, ids: new Set() });
  const selected = useMemo(() => selection.scope === preferenceScope ? selection.ids : new Set<string>(), [selection, preferenceScope]);
  const setSelected = useCallback((change: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    setSelection((previous) => {
      const old = previous.scope === preferenceScope ? previous.ids : new Set<string>();
      const ids = typeof change === "function" ? change(old) : change;
      return previous.scope === preferenceScope && ids === old ? previous : { scope: preferenceScope, ids };
    });
  }, [preferenceScope]);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const deleteInFlight = useRef(false);
  const [fleetSort, setFleetSort] = useFleetSort();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [preferences, updatePreferences] = useFleetPreferences(preferenceScope);
  const favoriteIds = useMemo(() => new Set(preferences.favorites), [preferences.favorites]);
  const [filters, setFilters] = useState<{ scope: string | null; search: string; status: FleetStatusFilter; view: "grid" | "table"; favoritesOnly: boolean }>({ scope: preferenceScope, search: "", status: "all", view: "grid", favoritesOnly: false });
  const currentFilters = filters.scope === preferenceScope ? filters : { search: "", status: "all" as const, view: "grid" as const, favoritesOnly: false };
  const [lastVerifiedScope, setLastVerifiedScope] = useState(preferenceScope);
  const contextChanged = Boolean(preferenceScope && lastVerifiedScope && preferenceScope !== lastVerifiedScope);
  const query = contextChanged ? "" : controlledQuery ?? currentFilters.search;
  useEffect(() => {
    if (preferenceScope && preferenceScope !== lastVerifiedScope) {
      if (lastVerifiedScope) onQueryChange?.("");
      setLastVerifiedScope(preferenceScope);
    }
  }, [preferenceScope, lastVerifiedScope, onQueryChange]);
  const [interactionScope, setInteractionScope] = useState(preferenceScope);
  if (interactionScope !== preferenceScope) {
    setInteractionScope(preferenceScope);
    setDeleteIds(null); setPowerModal(null); setDeleteError(null);
  }
  const viewMode = controlledViewMode ?? currentFilters.view;
  const changeFilters = (change: Partial<Omit<typeof filters, "scope">>) => setFilters((previous) => ({ ...(previous.scope === preferenceScope ? previous : { search: "", status: "all" as const, view: "grid" as const, favoritesOnly: false }), scope: preferenceScope, ...change }));
  const changeQuery = (value: string) => { changeFilters({ search: value }); onQueryChange?.(value); };
  const changeView = (value: "grid" | "table") => { changeFilters({ view: value }); onViewModeChange?.(value); };
  const applyView = (view: SavedFleetView) => {
    changeFilters({ search: view.search, view: view.view, status: view.status, favoritesOnly: view.favoritesOnly });
    onQueryChange?.(view.search); onViewModeChange?.(view.view); setFleetSort(view.sort);
  };
  const toggleFavorite = (id: string) => updatePreferences((previous) => ({ ...previous, favorites: previous.favorites.includes(id) ? previous.favorites.filter((favorite) => favorite !== id) : [...previous.favorites, id] }));
  useEffect(() => {
    if (preferences.favorites.some((id) => !agents[id])) updatePreferences((previous) => ({ ...previous, favorites: previous.favorites.filter((id) => Boolean(agents[id])) }));
  }, [agents, preferences.favorites, updatePreferences]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo<FleetRow[]>(() => {
    return Object.values(agents).map((agent) => {
      const id = agent.id;
      const entry = enrichment[id];
      const summary = entry?.status === "ready" ? entry.summary : null;
      const info = agentInfo[id] ?? summary?.info ?? null;
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
      const liveUptimeReceivedAt = agentInfo[id] ? agentInfoReceivedAtMs[id] ?? 0 : 0;
      const effectiveUptimeSecs =
        liveUptimeBase == null
          ? undefined
          : agent.online && liveUptimeReceivedAt
            ? liveUptimeBase + Math.max(0, Math.floor((nowMs - liveUptimeReceivedAt) / 1000))
            : liveUptimeBase;
      const internetBlocked = summary?.internet_blocked ?? null;
      const blockedApps = summary?.app_block_enabled_count ?? null;
      const isAfk = agent.online && status?.activity === "afk";
      const isActive = agent.online && status?.activity === "active";
      const rowStatus: FleetStatus = isAfk ? "afk" : isActive ? "active" : agent.online ? "connected" : "offline";

      const effectiveLiveStatus = {
        ...status,
        app: status?.app !== undefined || status?.window !== undefined ? status.app : summary?.last_window?.app,
        window: status?.app !== undefined || status?.window !== undefined ? status.window : summary?.last_window?.title,
      };

      return {
        ...agent,
        appBlockEnabledCount: blockedApps,
        appBlockExamples: null,
        enrichmentStatus: entry?.status ?? "loading",
        infoReportedAt: agentInfo[id] ? null : summary?.info_reported_at ?? null,
        windowReportedAt: status?.app !== undefined || status?.window !== undefined ? null : summary?.last_window?.reported_at ?? null,
        displayName,
        effectiveUptimeSecs,
        idleSecs,
        internetBlocked,
        internetBlockedSource: summary?.internet_block_source ?? null,
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
    enrichment,
    liveStatus,
    nowMs,
    versionPayload?.latest_agent_version,
  ]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const next = rows.filter((row) => {
      if (currentFilters.favoritesOnly && !favoriteIds.has(row.id)) return false;
      if (currentFilters.status === "online" && !row.online) return false;
      if (currentFilters.status === "offline" && row.online) return false;
      if ((currentFilters.status === "active" || currentFilters.status === "afk") && row.status !== currentFilters.status) return false;
      if (!needle) return true;
      return [row.displayName, row.id, row.user, row.ip, row.lastWindow, row.liveStatus?.app, row.liveStatus?.url]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    return sortFleet(next, fleetSort);
  }, [query, rows, fleetSort, currentFilters.favoritesOnly, currentFilters.status, favoriteIds]);

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
  }, [agents, deleting, setSelected]);

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
      updatePreferences((previous) => ({ ...previous, favorites: previous.favorites.filter((id) => !ids.includes(id)) }));
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

  return {
    agents,
    preferenceScope,
    query,
    currentFilters,
    viewMode,
    fleetSort,
    setFleetSort,
    preferences,
    updatePreferences,
    favoriteIds,
    toggleFavorite,
    rows,
    filteredRows,
    changeQuery,
    changeFilters,
    changeView,
    applyView,
    onQueryChange,
    isMobile,
    versionPayload,
    canDelete,
    selected,
    selectedIds,
    setSelected,
    toggleSelect,
    selectAllVisible,
    deleting,
    deleteError,
    deleteIds,
    setDeleteIds,
    requestDelete,
    confirmBulkDelete,
    removalIds,
    powerModal,
    setPowerModal,
    modalRow,
  };
}
