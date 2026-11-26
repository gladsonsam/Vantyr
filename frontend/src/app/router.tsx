import { lazy, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { DashboardLayout } from "./DashboardLayout";
import { useSession } from "@/app/providers/useSession";
import { usePageHeader, type PageHeader } from "@/app/shell/usePageHeader";

const OverviewPage = lazy(() =>
  import("@/features/fleet/OverviewPage").then((m) => ({ default: m.OverviewPage })),
);
const AgentRedirect = lazy(() =>
  import("@/features/agent-detail/AgentRedirect").then((m) => ({ default: m.AgentRedirect })),
);
const AccountSettingsPage = lazy(() =>
  import("@/features/settings/AccountSettingsPage").then((m) => ({
    default: m.AccountSettingsPage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const LogsPage = lazy(() =>
  import("@/features/logs/LogsPage").then((m) => ({ default: m.LogsPage })),
);
const RecallPage = lazy(() =>
  import("@/features/recall/RecallPage").then((m) => ({ default: m.RecallPage })),
);
const RulesPage = lazy(() =>
  import("@/features/rules/RulesPage").then((m) => ({ default: m.RulesPage })),
);
const GroupsPage = lazy(() =>
  import("@/features/groups/GroupsPage").then((m) => ({ default: m.GroupsPage })),
);
const DeviceLayout = lazy(() =>
  import("@/features/devices/DeviceLayout").then((m) => ({ default: m.DeviceLayout })),
);
const DeviceOverviewPage = lazy(() =>
  import("@/features/devices/pages/DeviceOverviewPage").then((m) => ({
    default: m.DeviceOverviewPage,
  })),
);
const AgentToolsRoute = lazy(() =>
  import("@/features/agent-detail/AgentToolsRoute").then((m) => ({ default: m.AgentToolsRoute })),
);
const DeviceDnsPage = lazy(() =>
  import("@/features/devices/pages/DeviceDnsPage").then((m) => ({ default: m.DeviceDnsPage })),
);
const DeviceProxyPage = lazy(() =>
  import("@/features/devices/pages/DeviceProxyPage").then((m) => ({ default: m.DeviceProxyPage })),
);
const NetworkLayout = lazy(() =>
  import("@/features/network/NetworkLayout").then((m) => ({ default: m.NetworkLayout })),
);
const NetworkOverviewPage = lazy(() =>
  import("@/features/network/overview/NetworkOverviewPage").then((m) => ({
    default: m.NetworkOverviewPage,
  })),
);
const NetworkPoliciesPage = lazy(() =>
  import("@/features/network/policies/NetworkPoliciesPage").then((m) => ({
    default: m.NetworkPoliciesPage,
  })),
);
const NetworkDnsPage = lazy(() =>
  import("@/features/network/dns/NetworkDnsPage").then((m) => ({ default: m.NetworkDnsPage })),
);
const NetworkProxyPage = lazy(() =>
  import("@/features/network/proxy/NetworkProxyPage").then((m) => ({
    default: m.NetworkProxyPage,
  })),
);
const NetworkGatewaysPage = lazy(() =>
  import("@/features/network/gateways/NetworkGatewaysPage").then((m) => ({
    default: m.NetworkGatewaysPage,
  })),
);
const GatewayDetailPage = lazy(() =>
  import("@/features/network/gateways/GatewayDetailPage").then((m) => ({
    default: m.GatewayDetailPage,
  })),
);
const NetworkActivityPage = lazy(() =>
  import("@/features/network/activity/NetworkActivityPage").then((m) => ({
    default: m.NetworkActivityPage,
  })),
);
const NetworkAuditPage = lazy(() =>
  import("@/features/network/audit/NetworkAuditPage").then((m) => ({
    default: m.NetworkAuditPage,
  })),
);
const NetworkHouseholdPage = lazy(() =>
  import("@/features/network/household/NetworkHouseholdPage").then((m) => ({
    default: m.NetworkHouseholdPage,
  })),
);
const NetworkAccessPage = lazy(() =>
  import("@/features/network/access-admin/NetworkAccessPage").then((m) => ({
    default: m.NetworkAccessPage,
  })),
);
const EnrollChooser = lazy(() =>
  import("@/features/network/enroll/EnrollChooser").then((m) => ({ default: m.EnrollChooser })),
);
const EnrollPage = lazy(() =>
  import("@/features/network/enroll/EnrollPage").then((m) => ({ default: m.EnrollPage })),
);
const DnsStatusPage = lazy(() =>
  import("@/features/network/dns-status/DnsStatusPage").then((m) => ({
    default: m.DnsStatusPage,
  })),
);
const UsersPage = lazy(() =>
  import("@/features/users/UsersPage").then((m) => ({ default: m.UsersPage })),
);

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
        {/* Legacy: the agent page lives in the device page now. */}
        <Route path="/agents/:agentId/*" element={<AgentRedirect />} />
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
            <Page
              title="Audit log"
              description="Sign-ins, operator actions and API calls on this server."
            >
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
                description="Replay screen history. Frames capture on window, URL or activity changes. Gaps mean nothing changed."
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
              <Page
                title="Rules"
                description="Alerts, app blocking, internet access and scheduled scripts across the fleet."
              >
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
                description="Target many agents at once with the same rules and policies."
              >
                <GroupsPage />
              </Page>
            </AdminOnly>
          }
        />
        <Route
          path="/users"
          element={
            <Page
              title="Users"
              description="Your profile, plus accounts, roles and sign-in links for administrators."
            >
              <UsersPage />
            </Page>
          }
        />
        <Route path="/devices/:deviceKey" element={<DeviceLayout />}>
          <Route index element={<DeviceOverviewPage />} />
          <Route path="agent" element={<AgentToolsRoute />} />
          <Route path="dns" element={<DeviceDnsPage />} />
          <Route path="proxy" element={<DeviceProxyPage />} />
        </Route>
        {/* Self-service BYOD enrollment stays outside the administrator-gated Network layout. */}
        <Route path="/network/enroll" element={<EnrollChooser />} />
        <Route path="/network/enroll/:householdId" element={<EnrollPage />} />
        {/* Events-only DNS status: also outside the administrator-gated layout. */}
        <Route path="/network/dns-status/:householdId" element={<DnsStatusPage />} />
        <Route path="/network" element={<NetworkLayout />}>
          <Route index element={<NetworkOverviewPage />} />
          <Route path="policies" element={<NetworkPoliciesPage />} />
          <Route path="dns" element={<NetworkDnsPage />} />
          <Route path="proxy" element={<NetworkProxyPage />} />
          <Route path="gateways" element={<NetworkGatewaysPage />} />
          <Route path="gateways/:gatewayId" element={<GatewayDetailPage />} />
          <Route path="household" element={<NetworkHouseholdPage />} />
          <Route path="activity" element={<NetworkActivityPage />} />
          <Route path="audit" element={<NetworkAuditPage />} />
          <Route path="access" element={<NetworkAccessPage />} />
          <Route path="*" element={<Navigate to="/network" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
