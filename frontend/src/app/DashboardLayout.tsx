import { useEffect, useMemo, useState } from "react";
import { Outlet, matchPath, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/app/shell/AppShell";
import { agentTabFromParam } from "@/features/agent-detail/lib/agentTabNav";
import { useNetworkAccess } from "@/features/network/access/useNetworkAccess";
import { useDeviceRows } from "@/features/devices/hooks/useDeviceRows";
import { connectedCount } from "@/features/devices/lib/deviceModel";
import { useAgents } from "@/app/providers/useAgents";
import { useNotifications } from "@/app/providers/useNotifications";
import { useSession } from "@/app/providers/useSession";
import { PageHeaderContext, type PageHeader } from "@/app/shell/usePageHeader";

export type ReturnToState = { from?: string } | null;

/**
 * Layout route for every signed-in page: mounts the shell once so the sidebar
 * survives navigation, and renders the matched page into it.
 */
export function DashboardLayout() {
  const { navUser, logout } = useSession();
  const { agents } = useAgents();
  const { notifications, removeNotification } = useNotifications();
  const network = useNetworkAccess();
  // Same rows the Devices page lists, so the badge counts every kind of device, once each.
  const { rows: deviceRows, loading: devicesLoading } = useDeviceRows();
  const onlineDevices = devicesLoading
    ? undefined
    : deviceRows.filter((row) => connectedCount(row) > 0).length;
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [header, setHeader] = useState<PageHeader>({ title: "" });
  const agentList = useMemo(() => Object.values(agents), [agents]);

  const returnTo: ReturnToState = { from: location.pathname + location.search };
  const onAgentPage =
    matchPath("/agents/:agentId", location.pathname) !== null ||
    matchPath("/devices/:deviceKey/agent", location.pathname) !== null;

  // Browser tabs and history name the page. A page that draws its own header (a device) names itself.
  const pageTitle = header.hideTopBar ? "" : header.title;
  useEffect(() => {
    if (!pageTitle) return;
    const previous = document.title;
    document.title = `${pageTitle} · Vantyr`;
    return () => {
      document.title = previous;
    };
  }, [pageTitle]);

  return (
    <PageHeaderContext.Provider value={setHeader}>
      <AppShell
        title={header.title}
        description={header.description}
        hideTopBar={header.hideTopBar}
        currentUser={navUser}
        onLogout={() => void logout()}
        // Header user-menu action → per-user Account settings. Server settings is a
        // separate destination reached from the sidebar (/settings).
        onShowPreferences={() => navigate("/account", { state: returnTo })}
        onOpenUsers={() => navigate("/users")}
        // Network access is its own scope, so the item appears only once the server confirms it.
        showNetwork={network.state === "ready" || network.state === "setup"}
        onOpenActivityLog={() => navigate("/logs", { state: returnTo })}
        onOpenNotifications={navUser?.role === "admin" ? () => navigate("/rules") : undefined}
        notifications={notifications}
        onDismissNotification={removeNotification}
        agents={agentList}
        onlineDevices={onlineDevices}
        totalDevices={devicesLoading ? undefined : deviceRows.length}
        // Switching devices from an agent page keeps the open tab.
        onSelectAgent={(agentId) => {
          const tab = onAgentPage ? agentTabFromParam(searchParams.get("tab")) : "activity";
          navigate(`/agents/${agentId}?tab=${tab}`);
        }}
      >
        <Outlet />
      </AppShell>
    </PageHeaderContext.Provider>
  );
}
