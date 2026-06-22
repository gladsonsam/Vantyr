import { DashboardLayout } from "../layouts/DashboardLayout";
import { SettingsPage } from "../pages/SettingsPage";
import { AccountSettingsPage } from "../pages/AccountSettingsPage";
import type { NotificationItem } from "../hooks/useNotifications";
import type { ThemeMode } from "../hooks/useTheme";
import type { DashboardNavUser } from "../lib/types";

interface Props {
  /** "account" → per-user settings (header menu); "server" → global config (sidebar). */
  variant?: "account" | "server";
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onBack: () => void;
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenActivityLog: () => void;
  onOpenUsers: () => void;
  onOpenNotifications?: () => void;
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
  toolsOpen: boolean;
  onToolsChange: (open: boolean) => void;
}

export function AuthenticatedSettings({
  variant = "server",
  themeMode,
  onThemeChange,
  onBack,
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  onGoHome,
  currentUser = null,
  notifications,
  onDismissNotification,
  toolsOpen,
  onToolsChange,
}: Props) {
  return (
    <DashboardLayout
      content={
        variant === "account" ? (
          <AccountSettingsPage
            themeMode={themeMode}
            onThemeChange={onThemeChange}
            onBack={onBack}
            currentUser={currentUser}
          />
        ) : (
          <SettingsPage onBack={onBack} currentUser={currentUser} />
        )
      }
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenActivityLog={onOpenActivityLog}
      onOpenUsers={onOpenUsers}
      onOpenNotifications={onOpenNotifications}
      onGoHome={onGoHome}
      contentType="default"
      currentUser={currentUser}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
      showTools={false}
      toolsOpen={toolsOpen}
      onToolsChange={onToolsChange}
    />
  );
}
