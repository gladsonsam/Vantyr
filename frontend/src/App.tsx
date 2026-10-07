import { useEffect, useCallback, lazy, Suspense, useMemo } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  isTabKey,
  type Agent,
  type AgentInfo,
  type AgentLiveStatus,
  type TabKey,
  type DashboardSessionUser,
  type DashboardNavUser,
} from "./lib/types";
import type { NotificationItem } from "./hooks/useNotifications";
import type { ThemeMode } from "./hooks/useTheme";
import { AppShell, LoadContent } from "./components/fleet/AppShell";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { api } from "./lib/api";
import { AgentsProvider } from "@/app/providers/AgentsProvider";
import { NotificationsProvider } from "@/app/providers/NotificationsProvider";
import { SessionProvider } from "@/app/providers/SessionProvider";
import { ThemeProvider } from "@/app/providers/ThemeProvider";
import { useAgents } from "@/app/providers/useAgents";
import { useAppTheme } from "@/app/providers/useAppTheme";
import { useNotifications } from "@/app/providers/useNotifications";
import { useSession } from "@/app/providers/useSession";

const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const AuthenticatedOverview = lazy(() => import("./routes/AuthenticatedOverview").then((m) => ({ default: m.AuthenticatedOverview })));
const AuthenticatedAgentDetail = lazy(() => import("./routes/AuthenticatedAgentDetail").then((m) => ({ default: m.AuthenticatedAgentDetail })));
const AuthenticatedSettings = lazy(() => import("./routes/AuthenticatedSettings").then((m) => ({ default: m.AuthenticatedSettings })));
const AuthenticatedLogs = lazy(() => import("./routes/AuthenticatedLogs").then((m) => ({ default: m.AuthenticatedLogs })));
const AuthenticatedRecall = lazy(() => import("./routes/AuthenticatedRecall").then((m) => ({ default: m.AuthenticatedRecall })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const AuthenticatedGroups = lazy(() => import("./routes/AuthenticatedGroups").then((m) => ({ default: m.AuthenticatedGroups })));
const AuthenticatedRules = lazy(() => import("./routes/AuthenticatedRules").then((m) => ({ default: m.AuthenticatedRules })));

function sessionToNavUser(u: DashboardSessionUser | null): DashboardNavUser | null {
  if (!u) return null;
  return {
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    display_icon: u.display_icon,
  };
}

/** Branded full-screen loader for auth/route-chunk loads — matches the index.html
 *  boot splash so the hand-off is seamless (no black flash). */
function LoadShell({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-[18px] bg-background font-sans text-muted-foreground">
      <div className="size-[42px] animate-spin rounded-full border-[3px] border-muted border-t-primary" />
      <div className="text-[13px] font-medium tracking-[0.02em]">{label}</div>
    </div>
  );
}

type NavState = { from?: string } | null;

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
}) {
  return (
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
      currentUser={sessionToNavUser(currentUser)}
    />
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
  if (!agent) {
    return (
      <AppShell
        title="Agent Details"
        currentUser={sessionToNavUser(currentUser)}
        onLogout={handleLogout}
        onShowPreferences={openSettings}
        onOpenUsers={onOpenUsers}
        onOpenActivityLog={openLogs}
        onOpenNotifications={onOpenNotifications}
        notifications={notifications}
        onDismissNotification={removeNotification}
        hideTopBar={true}
      >
        <LoadContent label="Loading agent…" />
      </AppShell>
    );
  }

  return (
    <AuthenticatedAgentDetail
      agent={agent}
      agents={agents}
      agentInfo={agentInfo[agent.id] || null}
      agentInfoById={agentInfo}
      liveStatus={liveStatus[agent.id]}
      liveStatusById={liveStatus}
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
      onSelectAgent={(nextAgentId) => navigate(`/agents/${nextAgentId}?tab=${activeTab}`)}
      onLogout={() => void handleLogout()}
      onShowPreferences={openSettings}
      onOpenActivityLog={openLogs}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onOpenAgentGroups={onOpenAgentGroups}
      onGoHome={() => navigate("/")}
      notifications={notifications}
      onDismissNotification={removeNotification}
      currentUser={sessionToNavUser(currentUser)}
      dashboardRole={currentUser?.role ?? null}
      dashboardAccountId={currentUser?.id ?? null}
      highlightTimestamp={highlightTimestamp}
    />
  );
}

function SettingsRoute({
  variant = "server",
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
}: {
  variant?: "account" | "server";
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
}) {
  const back = useReturnTo();
  const navigate = useNavigate();
  return (
    <AuthenticatedSettings
      variant={variant}
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
      currentUser={sessionToNavUser(currentUser)}
    />
  );
}

function LogsRoute({
  handleLogout,
  openSettings,
  openLogs,
  notifications,
  removeNotification,
  onOpenUsers,
  onOpenNotifications,
  currentUser,
}: {
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
}) {
  const navigate = useNavigate();
  return (
    <AuthenticatedLogs
      onLogout={() => void handleLogout()}
      onShowPreferences={openSettings}
      onOpenActivityLog={openLogs}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onGoHome={() => navigate("/")}
      notifications={notifications}
      onDismissNotification={removeNotification}
      currentUser={sessionToNavUser(currentUser)}
    />
  );
}


function RecallRoute({
  handleLogout,
  openSettings,
  openLogs,
  notifications,
  removeNotification,
  onOpenUsers,
  onOpenNotifications,
  currentUser,
}: {
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
}) {
  const navigate = useNavigate();
  // Recall endpoints are operator-gated server-side; keep viewers out of the view.
  if (currentUser && currentUser.role === "viewer") {
    return <Navigate to="/" replace />;
  }
  return (
    <AuthenticatedRecall
      onLogout={() => void handleLogout()}
      onShowPreferences={openSettings}
      onOpenActivityLog={openLogs}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onGoHome={() => navigate("/")}
      notifications={notifications}
      onDismissNotification={removeNotification}
      currentUser={sessionToNavUser(currentUser)}
    />
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
}: {
  handleLogout: () => Promise<void>;
  openSettings: () => void;
  openLogs: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  currentUser: DashboardSessionUser | null;
  notifications: NotificationItem[];
  removeNotification: (id: string) => void;
}) {
  const navigate = useNavigate();
  if (currentUser?.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return (
    <AuthenticatedGroups
      onLogout={() => void handleLogout()}
      onShowPreferences={openSettings}
      onOpenActivityLog={openLogs}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onGoHome={() => navigate("/")}
      notifications={notifications}
      onDismissNotification={removeNotification}
      currentUser={sessionToNavUser(currentUser)}
    />
  );
}

export function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <NotificationsProvider>
          <AgentsProvider>
            <Dashboard />
          </AgentsProvider>
        </NotificationsProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

function Dashboard() {
  const { authenticated, user: me, refresh: checkAuth, completeLogin, logout: handleLogout } = useSession();
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
    initialized: wsInitReceived,
    setSelectedAgentId,
    send,
    refresh: refreshDashboard,
  } = useAgents();

  useEffect(() => {
    const match = /^\/agents\/([^/]+)(?:\/|$)/.exec(location.pathname);
    if (authenticated === true && wsInitReceived && match && !agents[match[1]]) {
      navigate("/", { replace: true });
    }
  }, [authenticated, wsInitReceived, agents, location.pathname, navigate]);

  const { notifications, removeNotification, warning, info, error } = useNotifications();
  const { themeMode, changeTheme } = useAppTheme();

  const handleSelectAgent = (agentId: string, tab: TabKey = "activity", scroll?: boolean) => {
    const q = scroll ? "&scroll=activity" : "";
    navigate(`/agents/${agentId}?tab=${tab}${q}`);
  };

  const handleOpenScreen = (agentId: string) => {
    navigate(`/agents/${agentId}?tab=live`);
  };

  // Header user-menu action → per-user Account settings. Server settings is a
  // separate destination reached from the sidebar (/settings).
  const handleOpenSettings = () => {
    navigate("/account", { state: { from: location.pathname + location.search } satisfies NavState });
  };

  const handleOpenLogs = () => {
    navigate("/logs", { state: { from: location.pathname + location.search } satisfies NavState });
  };

  const runBatchWake = useCallback(
    async (agentIds: string[]) => {
      if (me?.role === "viewer") {
        error("Not permitted", "Viewers cannot wake agents. Ask an operator or administrator.");
        return;
      }
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
    [agents, error, info, me?.role, warning],
  );

  const runBatchAction = useCallback(
    (agentIds: string[], cmdType: "RestartHost" | "ShutdownHost" | "LockHost") => {
      if (me?.role === "viewer") {
        error("Not permitted", "Viewers cannot control agents. Ask an operator or administrator.");
        return;
      }
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
    [agents, error, info, me?.role, warning, send],
  );

  if (authenticated === null) {
    return <LoadShell />;
  }

  if (!authenticated) {
    return (
      <Suspense fallback={<LoadShell label="Loading sign-in…" />}>
        <LoginPage
          onLoginSuccess={completeLogin}
        />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary resetKey={location.pathname} label="route">
    <Suspense fallback={<LoadShell label="Loading page…" />}><Routes>
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
          />
        }
      />
      <Route
        path="/account"
        element={
          <SettingsRoute
            variant="account"
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
          />
        }
      />
      <Route
        path="/logs"
        element={
          <LogsRoute
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            openLogs={handleOpenLogs}
            notifications={notifications}
            removeNotification={removeNotification}
            onOpenUsers={() => navigate("/users")}
            onOpenNotifications={adminAlertRulesNav}
            currentUser={me}
          />
        }
      />
      <Route
        path="/recall"
        element={
          <RecallRoute
            handleLogout={handleLogout}
            openSettings={handleOpenSettings}
            openLogs={handleOpenLogs}
            notifications={notifications}
            removeNotification={removeNotification}
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
            <AuthenticatedRules
              onLogout={() => void handleLogout()}
              onShowPreferences={handleOpenSettings}
              onOpenActivityLog={handleOpenLogs}
              onOpenUsers={() => navigate("/users")}
              onOpenNotifications={adminAlertRulesNav}
              onGoHome={() => navigate("/")}
              notifications={notifications}
              onDismissNotification={removeNotification}
              currentUser={sessionToNavUser(me)}
            />
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
          />
        }
      />
      <Route
        path="/users"
        element={
          <AppShell
            title="Users"
            description="Your profile, plus accounts, roles and sign-in links for administrators."
            currentUser={sessionToNavUser(me)}
            onLogout={() => void handleLogout()}
            onShowPreferences={handleOpenSettings}
            onOpenUsers={() => navigate("/users")}
            onOpenActivityLog={handleOpenLogs}
            onOpenNotifications={adminAlertRulesNav}
            notifications={notifications}
            onDismissNotification={removeNotification}
          >
            <UsersPage onAccountUpdated={checkAuth} />
          </AppShell>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Suspense>
    </ErrorBoundary>
  );
}
