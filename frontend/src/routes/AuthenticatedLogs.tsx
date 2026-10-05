import { AppShell } from "../components/fleet/AppShell";
import { LogsPage } from "../pages/LogsPage";
import type { NotificationItem } from "../hooks/useNotifications";
import type { DashboardNavUser } from "../lib/types";

interface Props {
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenActivityLog?: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
}

export function AuthenticatedLogs({
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
      title="Audit log"
      description="Sign-ins, operator actions and API calls on this server."
      currentUser={currentUser}
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenUsers={onOpenUsers}
      onOpenActivityLog={onOpenActivityLog}
      onOpenNotifications={onOpenNotifications}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
    >
      <LogsPage />
    </AppShell>
  );
}
