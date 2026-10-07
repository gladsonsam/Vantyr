import { useMemo, useState } from "react";
import { Outlet, matchPath, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/app/shell/AppShell";
import { agentTabFromParam } from "@/lib/agentTabNav";
import { useAgents } from "./providers/useAgents";
import { useNotifications } from "./providers/useNotifications";
import { useSession } from "./providers/useSession";
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
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [header, setHeader] = useState<PageHeader>({ title: "" });
  const agentList = useMemo(() => Object.values(agents), [agents]);

  const returnTo: ReturnToState = { from: location.pathname + location.search };
  const onAgentPage = matchPath("/agents/:agentId", location.pathname) !== null;

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
        onOpenActivityLog={() => navigate("/logs", { state: returnTo })}
        onOpenNotifications={navUser?.role === "admin" ? () => navigate("/rules") : undefined}
        notifications={notifications}
        onDismissNotification={removeNotification}
        agents={agentList}
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
