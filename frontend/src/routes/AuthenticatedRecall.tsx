import { AppShell } from "../components/fleet/AppShell";
import { RecallPage } from "../pages/RecallPage";
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

export function AuthenticatedRecall({
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
      title="Recall"
      description="Replay screen history. Frames are captured when the window, URL or activity changes, so gaps mean nothing new happened."
      currentUser={currentUser}
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenUsers={onOpenUsers}
      onOpenActivityLog={onOpenActivityLog}
      onOpenNotifications={onOpenNotifications}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
    >
      <RecallPage />
    </AppShell>
  );
}
