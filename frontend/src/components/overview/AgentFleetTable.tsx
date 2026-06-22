import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentInfo, AgentLiveStatus, AppBlockRule, TabKey } from "../../lib/types";
import { api } from "../../lib/api";
import { primaryIp } from "../../lib/agentNetwork";
import { useServerVersionPayload } from "../../lib/serverVersionStore";
import type { ConsoleStatus, OsKind } from "../ui/console";
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
  onDeleteAgents?: (agentIds: string[]) => void;
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
  onBatchWake,
  onBatchLock,
  onBatchRestart,
  onBatchShutdown,
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
      const rowStatus: ConsoleStatus = internetBlocked ? "blocked" : isAfk ? "afk" : isActive ? "active" : agent.online ? "connected" : "offline";

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
    fallbackInfo,
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
      if (!needle) return true;
      return [row.displayName, row.id, row.user, row.ip, row.lastWindow, row.liveStatus?.app, row.liveStatus?.url]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    next.sort((a, b) => statusRank[b.status] - statusRank[a.status] || a.displayName.localeCompare(b.displayName));

    return next;
  }, [query, rows]);

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

  return (
    <>
      {viewMode === "table" && !isMobile ? (
        <AgentListView
          filteredRows={filteredRows}
          onSelectAgent={onSelectAgent}
          onOpenScreen={onOpenScreen}
          setPowerModal={setPowerModal}
          latestAgentVersion={versionPayload?.latest_agent_version}
        />
      ) : (
        <AgentCardGrid
          filteredRows={filteredRows}
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
    </>
  );
}
