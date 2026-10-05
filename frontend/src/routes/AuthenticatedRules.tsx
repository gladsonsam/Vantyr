import { AppShell } from "../components/fleet/AppShell";
import { RulesPage } from "../pages/RulesPage";
import type { NotificationItem } from "../hooks/useNotifications";
import type { DashboardNavUser } from "../lib/types";

interface Props {
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenActivityLog: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
}

export function AuthenticatedRules({
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  currentUser = null,
  notifications,
  onDismissNotification,
}: Props) {
  return (
    <AppShell
      title="Rules"
      description="Alerts, app blocking, internet access and scheduled scripts across the fleet."
      currentUser={currentUser}
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenUsers={onOpenUsers}
      onOpenActivityLog={onOpenActivityLog}
      onOpenNotifications={onOpenNotifications}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
    >
      <RulesPage />
    </AppShell>
  );
}
