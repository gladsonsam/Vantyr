import { lazy, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { DashboardLayout } from "./DashboardLayout";
import { useSession } from "./providers/useSession";
import { usePageHeader, type PageHeader } from "@/app/shell/usePageHeader";

const OverviewPage = lazy(() => import("@/pages/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const AgentDetailRoute = lazy(() => import("./AgentDetailRoute").then((m) => ({ default: m.AgentDetailRoute })));
const AccountSettingsPage = lazy(() => import("@/pages/AccountSettingsPage").then((m) => ({ default: m.AccountSettingsPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const LogsPage = lazy(() => import("@/pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const RecallPage = lazy(() => import("@/features/recall/RecallPage").then((m) => ({ default: m.RecallPage })));
const RulesPage = lazy(() => import("@/features/rules/RulesPage").then((m) => ({ default: m.RulesPage })));
const GroupsPage = lazy(() => import("@/features/groups/GroupsPage").then((m) => ({ default: m.GroupsPage })));
const UsersPage = lazy(() => import("@/features/users/UsersPage").then((m) => ({ default: m.UsersPage })));

/** Sets the shell's title block, then renders the page. */
function Page({ children, ...header }: PageHeader & { children: ReactNode }) {
  usePageHeader(header);
  return children;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return user?.role === "admin" ? children : <Navigate to="/" replace />;
}

function OperatorOnly({ children }: { children: ReactNode }) {
  const { user } = useSession();
  // Recall endpoints are operator-gated server-side; keep viewers out of the view.
  return user && user.role === "viewer" ? <Navigate to="/" replace /> : children;
}

/** Signed-in routes; all render inside the one persistent dashboard shell. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="/agents/:agentId" element={<AgentDetailRoute />} />
        <Route
          path="/account"
          element={
            <Page
              title="Account settings"
              description="Settings for your own dashboard sign-in. These apply only to you — not to other users or the server."
            >
              <AccountSettingsPage />
            </Page>
          }
        />
        <Route
          path="/settings"
          element={
            <Page
              title="Settings"
              description="Server-wide configuration for Vantyr and every enrolled agent. Most options need an administrator."
            >
              <SettingsPage />
            </Page>
          }
        />
        <Route
          path="/logs"
          element={
            <Page title="Audit log" description="Sign-ins, operator actions and API calls on this server.">
              <LogsPage />
            </Page>
          }
        />
        <Route
          path="/recall"
          element={
            <OperatorOnly>
              <Page
                title="Recall"
                description="Replay screen history. Frames are captured when the window, URL or activity changes, so gaps mean nothing new happened."
              >
                <RecallPage />
              </Page>
            </OperatorOnly>
          }
        />
        <Route path="/notifications" element={<Navigate to="/rules" replace />} />
        <Route
          path="/rules"
          element={
            <AdminOnly>
              <Page title="Rules" description="Alerts, app blocking, internet access and scheduled scripts across the fleet.">
                <RulesPage />
              </Page>
            </AdminOnly>
          }
        />
        <Route
          path="/groups"
          element={
            <AdminOnly>
              <Page
                title="Groups"
                description="Target many agents at once with the same rules and policies. Open a group to manage its members."
              >
                <GroupsPage />
              </Page>
            </AdminOnly>
          }
        />
        <Route
          path="/users"
          element={
            <Page title="Users" description="Your profile, plus accounts, roles and sign-in links for administrators.">
              <UsersPage />
            </Page>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
