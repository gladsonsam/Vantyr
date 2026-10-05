import { AppShell } from "../components/fleet/AppShell";
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
  currentUser = null,
  notifications,
  onDismissNotification,
}: Props) {
  return (
    <AppShell
      title={variant === "account" ? "Account settings" : "Settings"}
      description={
        variant === "account"
          ? "Settings for your own dashboard sign-in. These apply only to you — not to other users or the server."
          : "Server-wide configuration for Vantyr and every enrolled agent. Most options need an administrator."
      }
      currentUser={currentUser}
      onLogout={onLogout}
      onShowPreferences={onShowPreferences}
      onOpenUsers={onOpenUsers}
      onOpenActivityLog={onOpenActivityLog}
      onOpenNotifications={onOpenNotifications}
      notifications={notifications}
      onDismissNotification={onDismissNotification}
    >
      {variant === "account" ? (
        <AccountSettingsPage
          themeMode={themeMode}
          onThemeChange={onThemeChange}
          onBack={onBack}
          currentUser={currentUser}
        />
      ) : (
        <SettingsPage currentUser={currentUser} />
      )}
    </AppShell>
  );
}
