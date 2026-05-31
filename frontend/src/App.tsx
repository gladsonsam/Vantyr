import { useState, useEffect, useRef, useCallback, lazy, Suspense, useMemo } from "react";
import "@cloudscape-design/global-styles/index.css";
import "./styles/cloudscape-theme.css";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAgents } from "./hooks/useAgents";
import { useTheme } from "./hooks/useTheme";
import { useNotifications } from "./hooks/useNotifications";
import { api, setDashboardCsrfToken } from "./lib/api";
import type {
  Agent,
  AgentInfo,
  AgentLiveStatus,
  TabKey,
  DashboardSessionUser,
  DashboardNavUser,
  WsEvent,
} from "./lib/types";
import type { NotificationItem } from "./hooks/useNotifications";
import type { ThemeMode } from "./hooks/useTheme";
import { DashboardLayout } from "./layouts/DashboardLayout";

const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const AuthenticatedOverview = lazy(() =>
  import("./routes/AuthenticatedOverview").then((m) => ({ default: m.AuthenticatedOverview })),
);
const AuthenticatedAgentDetail = lazy(() =>
  import("./routes/AuthenticatedAgentDetail").then((m) => ({ default: m.AuthenticatedAgentDetail })),
);
const AuthenticatedSettings = lazy(() =>
  import("./routes/AuthenticatedSettings").then((m) => ({ default: m.AuthenticatedSettings })),
);
const AuthenticatedLogs = lazy(() =>
  import("./routes/AuthenticatedLogs").then((m) => ({ default: m.AuthenticatedLogs })),
);
const UsersPage = lazy(() => import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const AuthenticatedGroups = lazy(() =>
  import("./routes/AuthenticatedGroups").then((m) => ({ default: m.AuthenticatedGroups })),
);
const AuthenticatedRules = lazy(() =>
  import("./routes/AuthenticatedRules").then((m) => ({ default: m.AuthenticatedRules })),
);

function sessionToNavUser(u: DashboardSessionUser | null): DashboardNavUser | null {
  if (!u) return null;
  return {
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    display_icon: u.display_icon,
  };
}

/** Minimal first paint (no Cloudscape) while auth or route chunks load. */
function LoadShell({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      style={{
        minHeight: "45vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
        fontSize: 15,
        color: "var(--awsui-color-text-body-secondary)",
      }}
    >
      {label}
    </div>
  );
}

type NavState = { from?: string } | null;

function isTabKey(v: string | null): v is TabKey {
  return (
    v === "live" ||
    v === "activity" ||
    v === "specs" ||
    v === "software" ||
    v === "scripts" ||
    v === "logs" ||
    v === "analytics" ||
    v === "keys" ||
    v === "windows" ||
    v === "urls" ||
    v === "alerts" ||
    v === "files" ||
    v === "control" ||
    v === "settings"
  );
}

function useReturnTo() {
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as NavState)?.from;
  return useCallback(() => {
    navigate(from ?? "/", { replace: true });
  }, [from, navigate]);
}

function OverviewRoute({
  agents,
  liveStatus,
  agentInfo,
  agentInfoReceivedAtMs,
  loadingAgents,
  onSelectAgent,
  onOpenScreen,
  onOpenUsers,
  onOpenNotifications,
  currentUser,
  checkAuth,
  runBatchWake,
  runBatchAction,
  handleLogout,
  openSettings,
  openLogs,
  notifications,
  removeNotification,
  toolsOpen,
  setToolsOpen,
}: {
  agents: Record<string, Agent>;
  liveStatus: Record<string, AgentLiveStatus>;
  agentInfo: Record<string, AgentInfo | null>;
  agentInfoReceivedAtMs: Record<string, number>;
  loadingAgents: boolean;
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
  checkAuth: () => void;
  runBatchWake: (ids: string[]) => Promise<void>;
  runBatchAction: (agentIds: string[], cmdType: "RestartHost" | "ShutdownHost" | "LockHost") => void;
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  toolsOpen: boolean;
  setToolsOpen: (open: boolean) => void;
}) {
  return (
    <Suspense fallback={<LoadShell label="Loading dashboard…" />}>
      <AuthenticatedOverview
        agents={agents}
        liveStatus={liveStatus}
        agentInfo={agentInfo}
        agentInfoReceivedAtMs={agentInfoReceivedAtMs}
        loadingAgents={loadingAgents}
        onSelectAgent={onSelectAgent}
        onOpenScreen={onOpenScreen}
        onRefresh={checkAuth}
        onBatchWake={(ids) => void runBatchWake(ids)}
        onBatchLock={(agentIds) => {
          runBatchAction(agentIds, "LockHost");
        }}
        onBatchRestart={(agentIds) => {
          runBatchAction(agentIds, "RestartHost");
        }}
        onBatchShutdown={(agentIds) => {
          runBatchAction(agentIds, "ShutdownHost");
        }}
        onLogout={() => void handleLogout()}
        onShowPreferences={openSettings}
        onOpenActivityLog={openLogs}
        onOpenUsers={onOpenUsers}
        onOpenNotifications={onOpenNotifications}
        onGoHome={() => {}}
        notifications={notifications}
        onDismissNotification={removeNotification}
        toolsOpen={toolsOpen}
        onToolsChange={setToolsOpen}
        currentUser={sessionToNavUser(currentUser)}
      />
    </Suspense>
  );
}

function AgentDetailRoute({
  agents,
  agentInfo,
  liveStatus,
  setSelectedAgentId,
  send,
  info,
  warning,
  error,
  handleLogout,
  openSettings,
  openLogs,
  onOpenUsers,
  onOpenNotifications,
  onOpenAgentGroups,
  currentUser,
  notifications,
  removeNotification,
  toolsOpen,
  setToolsOpen,
  updateAgentInfo,
}: {
  agents: Record<string, Agent>;
  agentInfo: Record<string, AgentInfo | null>;
  liveStatus: Record<string, AgentLiveStatus>;
  setSelectedAgentId: (id: string | null) => void;
  send: (msg: unknown) => void;
  info: (header: string, content?: string) => void;
  warning: (header: string, content?: string) => void;
  error: (header: string, content?: string) => void;
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  onOpenAgentGroups?: () => void;
  currentUser: DashboardSessionUser | null;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  toolsOpen: boolean;
  setToolsOpen: (open: boolean) => void;
  updateAgentInfo: (id: string, info: AgentInfo | null) => void;
}) {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = useMemo<TabKey>(() => {
    const tab = searchParams.get("tab");
    if (tab === "screen") return "live";
    return isTabKey(tab) ? tab : "activity";
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("tab") !== "screen") return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", "live");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  // ISO timestamp for timeline highlight (from ?at=)
  const highlightTimestamp = searchParams.get("at") ?? null;

  useEffect(() => {
    setSelectedAgentId(agentId ?? null);
    return () => setSelectedAgentId(null);
  }, [agentId, setSelectedAgentId]);

  const agent = agentId ? agents[agentId] : null;
  if (!agentId) return <Navigate to="/" replace />;
  if (!agent) return <LoadShell label="Loading agent…" />;

  return (
    <Suspense fallback={<LoadShell label="Loading agent…" />}>
      <AuthenticatedAgentDetail
        agent={agent}
        agentInfo={agentInfo[agent.id] || null}
        liveStatus={liveStatus[agent.id]}
        sendWsMessage={send}
        onNotifyInfo={info}
        onNotifyWarning={warning}
        onNotifyError={error}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("tab", tab);
            return next;
          });
        }}
        onBackToOverview={() => navigate("/")}
        onOpenHelp={() => setToolsOpen(true)}
        onLogout={() => void handleLogout()}
        onShowPreferences={openSettings}
        onOpenActivityLog={openLogs}
        onOpenUsers={onOpenUsers}
        onOpenNotifications={onOpenNotifications}
        onOpenAgentGroups={onOpenAgentGroups}
        onGoHome={() => navigate("/")}
        notifications={notifications}
        onDismissNotification={removeNotification}
        toolsOpen={toolsOpen}
        onToolsChange={setToolsOpen}
        currentUser={sessionToNavUser(currentUser)}
        dashboardRole={currentUser?.role ?? null}
        highlightTimestamp={highlightTimestamp}
        onAgentInfoCommit={updateAgentInfo}
      />
    </Suspense>
  );
}

function SettingsRoute({
  themeMode,
  changeTheme,
  handleLogout,
  openSettings,
  openLogs,
  onOpenUsers,
  onOpenNotifications,
  currentUser,
  notifications,
  removeNotification,
  toolsOpen,
  setToolsOpen,
}: {
  themeMode: ThemeMode;
  changeTheme: (mode: ThemeMode) => void;
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  toolsOpen: boolean;
  setToolsOpen: (open: boolean) => void;
}) {
  const back = useReturnTo();
  const navigate = useNavigate();
  return (
    <Suspense fallback={<LoadShell label="Loading settings…" />}>
      <AuthenticatedSettings
        themeMode={themeMode}
        onThemeChange={changeTheme}
        onBack={back}
        onLogout={() => void handleLogout()}
        onShowPreferences={openSettings}
        onOpenActivityLog={openLogs}
        onOpenUsers={onOpenUsers}
        onOpenNotifications={onOpenNotifications}
        onGoHome={() => navigate("/")}
        notifications={notifications}
        onDismissNotification={removeNotification}
        toolsOpen={toolsOpen}
        onToolsChange={setToolsOpen}
        currentUser={sessionToNavUser(currentUser)}
      />
    </Suspense>
  );
}

function LogsRoute({
  handleLogout,
  openSettings,
  notifications,
  removeNotification,
  toolsOpen,
  setToolsOpen,
  onOpenUsers,
  onOpenNotifications,
  currentUser,
}: {
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  toolsOpen: boolean;
  setToolsOpen: (open: boolean) => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
}) {
  const navigate = useNavigate();
  return (
    <Suspense fallback={<LoadShell label="Loading activity log…" />}>
      <AuthenticatedLogs
        onLogout={() => void handleLogout()}
        onShowPreferences={openSettings}
        onOpenUsers={onOpenUsers}
        onOpenNotifications={onOpenNotifications}
        onGoHome={() => navigate("/")}
        notifications={notifications}
        onDismissNotification={removeNotification}
        toolsOpen={toolsOpen}
        onToolsChange={setToolsOpen}
        currentUser={sessionToNavUser(currentUser)}
      />
    </Suspense>
  );
}


function GroupsRoute({
  handleLogout,
  openSettings,
  openLogs,
  onOpenUsers,
  onOpenNotifications,
  currentUser,
  notifications,
  removeNotification,
  toolsOpen,
  setToolsOpen,
}: {
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  toolsOpen: boolean;
  setToolsOpen: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  if (currentUser?.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return (
    <Suspense fallback={<LoadShell label="Loading groups…" />}>
      <AuthenticatedGroups
        onLogout={() => void handleLogout()}
        onShowPreferences={openSettings}
        onOpenActivityLog={openLogs}
        onOpenUsers={onOpenUsers}
        onOpenNotifications={onOpenNotifications}
        onGoHome={() => navigate("/")}
        notifications={notifications}
        onDismissNotification={removeNotification}
        toolsOpen={toolsOpen}
        onToolsChange={setToolsOpen}
        currentUser={sessionToNavUser(currentUser)}
      />
    </Suspense>
  );
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [wsInitReceived, setWsInitReceived] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [me, setMe] = useState<DashboardSessionUser | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const openAgentGroupsAdmin = useCallback(() => navigate("/groups"), [navigate]);
  const openAlertRulesAdmin = useCallback(() => navigate("/rules"), [navigate]);
  const adminAgentGroupsNav = me?.role === "admin" ? openAgentGroupsAdmin : undefined;
  const adminAlertRulesNav = me?.role === "admin" ? openAlertRulesAdmin : undefined;

  const {
    agents,
    liveStatus,
    agentInfo,
    agentInfoReceivedAtMs,
    updateAgent,
    updateAgentLiveStatus,
    updateAgentInfo,
    setAllAgents,
    setSelectedAgentId,
  } = useAgents();

  const { notifications, removeNotification, warning, info, error } = useNotifications();
  const { themeMode, changeTheme } = useTheme();
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectNotifiedRef = useRef(false);

  const checkAuth = useCallback(async () => {
    try {
      const st = await api.authStatus();
      if (!st?.authenticated) {
        setMe(null);
        setDashboardCsrfToken(null);
        setAuthenticated(false);
        return;
      }
      const data = await api.me().catch(() => null);
      setMe(data);
      if (data && typeof data.csrf_token === "string" && data.csrf_token.length > 0) {
        setDashboardCsrfToken(data.csrf_token);
      } else {
        setDashboardCsrfToken(null);
      }
      setAuthenticated(true);
    } catch {
      setAuthenticated(false);
      setMe(null);
      setDashboardCsrfToken(null);
    }
  }, []);

  const refreshDashboard = useCallback(async () => {
    // One place to emulate a browser refresh: re-check auth + refetch the main caches we normally
    // seed on load (agents list + last-known telemetry + agent info).
    await checkAuth();

    let nextAgents: Agent[] = [];
    try {
      const res = await api.agentsOverview();
      nextAgents = Array.isArray(res?.agents) ? res.agents : [];
    } catch {
      nextAgents = [];
    }

    if (nextAgents.length > 0) {
      const agentMap: Record<string, Agent> = {};
      for (const a of nextAgents) agentMap[a.id] = a;
      setAllAgents(agentMap);
    }

    const ids = nextAgents.map((a) => a.id);
    if (ids.length === 0) {
      return;
    }

    // Concurrency-limited fanout so we don't spam the server on large fleets.
    const withConcurrency = async <T,>(
      items: string[],
      limit: number,
      fn: (id: string) => Promise<T>,
    ): Promise<void> => {
      let i = 0;
      const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (true) {
          const idx = i++;
          if (idx >= items.length) return;
          await fn(items[idx]).catch(() => undefined);
        }
      });
      await Promise.all(runners);
    };

    await withConcurrency(ids, 8, async (id) => {
      // Accumulate only the fields we actually fetched into a patch; the hook merges it onto the
      // latest snapshot, so we never clobber concurrent live events with a stale render snapshot.
      const patch: Partial<AgentLiveStatus> = {};

      // Agent info (uptime/hostname/etc.)
      try {
        const infoRes = await api.agentInfo(id);
        updateAgentInfo(id, infoRes?.info ?? null);
      } catch {
        // keep stale
      }

      // Last window (fallback for when WS live events were missed/disconnected)
      try {
        const winRes = await api.windows(id, { limit: 1, offset: 0 });
        const row = Array.isArray(winRes?.rows) ? winRes.rows[0] : null;
        const title = typeof row?.title === "string" ? row.title : null;
        const app = typeof row?.app === "string" ? row.app : null;
        if (title && title.trim() !== "") {
          patch.window = title;
          if (app) patch.app = app;
        }
      } catch {
        // keep stale
      }

      // Last URL (same idea as last window; not shown on cards today but used across the UI)
      try {
        const urlRes = await api.urls(id, { limit: 1, offset: 0 });
        const row = Array.isArray(urlRes?.rows) ? urlRes.rows[0] : null;
        const url = typeof row?.url === "string" ? row.url : null;
        if (url && url.trim() !== "") {
          patch.url = url;
        }
      } catch {
        // keep stale
      }

      // Commit the merged patch (no-op merge is harmless when nothing was fetched).
      updateAgentLiveStatus(id, patch);
    });

  }, [checkAuth, setAllAgents, updateAgentInfo, updateAgentLiveStatus]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const wsEnabled = authenticated === true;

  useEffect(() => {
    if (authenticated !== true) {
      setWsInitReceived(false);
    }
  }, [authenticated]);

  const { send } = useWebSocket({
    enabled: wsEnabled,
    onMessage: (event: WsEvent) => {
      switch (event.event) {
        case "init": {
          const agentMap: Record<string, Agent> = {};
          event.agents.forEach((agent) => {
            agentMap[agent.id] = agent;
          });
          setAllAgents(agentMap);
          setWsInitReceived(true);
          break;
        }

        case "agent_connected":
          if (event.agent_id && event.name) {
            const name = event.name;
            // Merge over the latest state so a concurrent icon/info update isn't lost.
            updateAgent(event.agent_id, (prev) => ({
              ...prev,
              id: event.agent_id,
              name,
              icon: prev?.icon ?? null,
              online: true,
              first_seen: prev?.first_seen || event.connected_at || "",
              last_seen: event.connected_at || "",
              connected_at: event.connected_at,
              last_connected_at: event.connected_at,
              last_disconnected_at: null,
            }));
          }
          break;

        case "agent_disconnected":
          if (event.agent_id) {
            // No-op when the agent isn't known; otherwise flip online off in-place.
            updateAgent(event.agent_id, (prev) =>
              prev ? { ...prev, online: false } : prev,
            );
          }
          break;

        case "window_focus":
          if (event.agent_id) {
            updateAgentLiveStatus(event.agent_id, {
              window: event.title,
              app: event.app,
            });
          }
          break;

        case "url":
          if (event.agent_id && event.url) {
            updateAgentLiveStatus(event.agent_id, {
              url: event.url,
            });
          }
          break;

        case "afk":
          if (event.agent_id) {
            const idleSecs = typeof event.idle_secs === "number" && event.idle_secs >= 0 ? event.idle_secs : 0;
            updateAgentLiveStatus(event.agent_id, {
              activity: "afk",
              idleSecs,
              idleSinceMs: Date.now() - idleSecs * 1000,
            });
          }
          break;

        case "active":
          if (event.agent_id) {
            updateAgentLiveStatus(event.agent_id, {
              activity: "active",
              idleSecs: 0,
              idleSinceMs: undefined,
            });
          }
          break;

        case "agent_info":
          if (event.agent_id && event.data) {
            updateAgentInfo(event.agent_id, event.data);
          }
          break;

        case "alert_rule_match": {
          const aid = event.agent_id;
          const agentLabel =
            (aid && agents[aid]?.name) || event.agent_name || aid || "Agent";
          const ruleLabel = event.rule_name || `Rule #${event.rule_id ?? "?"}`;
          const snippet = event.snippet ? ` — ${event.snippet}` : "";
          warning("Alert rule matched", `${ruleLabel} · ${agentLabel}${snippet}`);
          break;
        }
      }
    },
    onStatusChange: (status) => {
      if (status === "connected") {
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        disconnectNotifiedRef.current = false;
      } else if (status === "disconnected") {
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
        }
        disconnectTimerRef.current = setTimeout(() => {
          disconnectNotifiedRef.current = true;
        }, 10000);
      }
    },
  });

  // Agent versions now come from the server's WS init payload (`agent_version` per agent),
  // so we don't need an N+1 `/agents/:id/info` prefetch here.

  useEffect(() => {
    return () => {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
      }
    };
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch (err) {
      console.error("Logout error:", err);
    }
    setDashboardCsrfToken(null);
    setAuthenticated(false);
  };

  const handleSelectAgent = (agentId: string) => {
    navigate(`/agents/${agentId}?tab=activity`);
  };

  const handleOpenScreen = (agentId: string) => {
    navigate(`/agents/${agentId}?tab=live`);
  };

  const handleOpenSettings = () => {
    navigate("/settings", { state: { from: location.pathname + location.search } satisfies NavState });
  };

  const handleOpenLogs = () => {
    navigate("/logs", { state: { from: location.pathname + location.search } satisfies NavState });
  };

  const runBatchWake = useCallback(
    async (agentIds: string[]) => {
      if (agentIds.length === 0) return;
      const results = await Promise.allSettled(agentIds.map((id) => api.wakeAgent(id)));
      let ok = 0;
      const errors: string[] = [];
      results.forEach((r, i) => {
        const name = agents[agentIds[i]]?.name ?? agentIds[i];
        if (r.status === "fulfilled") ok += 1;
        else errors.push(`${name}: ${r.reason}`);
      });
      const fail = results.length - ok;
      if (fail === 0) {
        info(
          `Wake on LAN sent to ${ok} machine(s)`,
          "Magic packets use the MAC from each agent’s last stored system info.",
        );
      } else if (ok === 0) {
        error(
          "Wake on LAN failed",
          errors
            .slice(0, 3)
            .map((s) => String(s).replace(/^Error: /, ""))
            .join(" · ") + (errors.length > 3 ? " …" : ""),
        );
      } else {
        warning(
          `Wake sent to ${ok}; ${fail} failed`,
          errors
            .slice(0, 2)
            .map((s) => String(s).replace(/^Error: /, ""))
            .join(" · "),
        );
      }
    },
    [agents, error, info, warning],
  );

  const runBatchAction = useCallback(
    (agentIds: string[], cmdType: "RestartHost" | "ShutdownHost" | "LockHost") => {
      const onlineIds = agentIds.filter((id) => agents[id]?.online);
      const offlineCount = agentIds.length - onlineIds.length;

      if (onlineIds.length === 0) {
        warning("No online agents selected", "Select at least one online agent to send this action.");
        return;
      }

      for (const id of onlineIds) {
        send({
          type: "control",
          agent_id: id,
          cmd: { type: cmdType },
        });
      }

      const actionLabel =
        cmdType === "RestartHost" ? "restart" : cmdType === "ShutdownHost" ? "shutdown" : "lock";
      if (offlineCount > 0) {
        warning(
          `Sent ${actionLabel} to ${onlineIds.length} agent(s)`,
          `${offlineCount} offline agent(s) were skipped.`,
        );
      } else {
        info(`Sent ${actionLabel} to ${onlineIds.length} agent(s)`, "Commands queued over WebSocket.");
      }
    },
    [agents, info, warning, send],
  );

  if (authenticated === null) {
    return <LoadShell />;
  }

  if (!authenticated) {
    return (
      <Suspense fallback={<LoadShell label="Loading sign-in…" />}>
        <LoginPage onLoginSuccess={() => setAuthenticated(true)} />
      </Suspense>
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <OverviewRoute
            agents={agents}
            liveStatus={liveStatus}
            agentInfo={agentInfo}
            agentInfoReceivedAtMs={agentInfoReceivedAtMs}
            loadingAgents={!wsInitReceived}
            onSelectAgent={handleSelectAgent}
            onOpenScreen={handleOpenScreen}
            onOpenUsers={() => navigate("/users")}
            onOpenNotifications={adminAlertRulesNav}
            currentUser={me}
            checkAuth={refreshDashboard}
            runBatchWake={runBatchWake}
            runBatchAction={runBatchAction}
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            openLogs={handleOpenLogs}
            notifications={notifications}
            removeNotification={removeNotification}
            toolsOpen={toolsOpen}
            setToolsOpen={setToolsOpen}
          />
        }
      />
      <Route
        path="/agents/:agentId"
        element={
          <AgentDetailRoute
            agents={agents}
            agentInfo={agentInfo}
            liveStatus={liveStatus}
            setSelectedAgentId={setSelectedAgentId}
            send={send}
            info={info}
            warning={warning}
            error={error}
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            openLogs={handleOpenLogs}
            onOpenUsers={() => navigate("/users")}
            onOpenNotifications={adminAlertRulesNav}
            onOpenAgentGroups={adminAgentGroupsNav}
            currentUser={me}
            notifications={notifications}
            removeNotification={removeNotification}
            toolsOpen={toolsOpen}
            setToolsOpen={setToolsOpen}
            updateAgentInfo={updateAgentInfo}
          />
        }
      />
      <Route
        path="/settings"
        element={
          <SettingsRoute
            themeMode={themeMode}
            changeTheme={changeTheme}
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            openLogs={handleOpenLogs}
            onOpenUsers={() => navigate("/users")}
            onOpenNotifications={adminAlertRulesNav}
            currentUser={me}
            notifications={notifications}
            removeNotification={removeNotification}
            toolsOpen={toolsOpen}
            setToolsOpen={setToolsOpen}
          />
        }
      />
      <Route
        path="/logs"
        element={
          <LogsRoute
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            notifications={notifications}
            removeNotification={removeNotification}
            toolsOpen={toolsOpen}
            setToolsOpen={setToolsOpen}
            onOpenUsers={() => navigate("/users")}
            onOpenNotifications={adminAlertRulesNav}
            currentUser={me}
          />
        }
      />
      <Route path="/notifications" element={<Navigate to="/rules" replace />} />
      <Route
        path="/rules"
        element={
          me?.role !== "admin" ? (
            <Navigate to="/" replace />
          ) : (
            <Suspense fallback={<LoadShell label="Loading rules…" />}>
              <AuthenticatedRules
                onLogout={() => void handleLogout()}
                onShowPreferences={handleOpenSettings}
                onOpenActivityLog={handleOpenLogs}
                onOpenUsers={() => navigate("/users")}
                onOpenNotifications={adminAlertRulesNav}
                onGoHome={() => navigate("/")}
                notifications={notifications}
                onDismissNotification={removeNotification}
                toolsOpen={toolsOpen}
                onToolsChange={setToolsOpen}
                currentUser={sessionToNavUser(me)}
              />
            </Suspense>
          )
        }
      />
      <Route
        path="/groups"
        element={
          <GroupsRoute
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            openLogs={handleOpenLogs}
            onOpenUsers={() => navigate("/users")}
            onOpenNotifications={adminAlertRulesNav}
            currentUser={me}
            notifications={notifications}
            removeNotification={removeNotification}
            toolsOpen={toolsOpen}
            setToolsOpen={setToolsOpen}
          />
        }
      />
      <Route
        path="/users"
        element={
          <Suspense fallback={<LoadShell label="Loading users…" />}>
            <DashboardLayout
              content={<UsersPage onAccountUpdated={checkAuth} />}
              onLogout={() => void handleLogout()}
              onShowPreferences={handleOpenSettings}
              onOpenActivityLog={handleOpenLogs}
              onOpenNotifications={adminAlertRulesNav}
              onGoHome={() => navigate("/")}
              contentType="default"
              notifications={notifications}
              onDismissNotification={removeNotification}
              showTools={false}
              toolsOpen={toolsOpen}
              onToolsChange={setToolsOpen}
              currentUser={sessionToNavUser(me)}
              onOpenUsers={() => navigate("/users")}
            />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
