import { ContentLayout, SpaceBetween, Header, Button } from "../components/ui/console";
import type { ThemeMode } from "../hooks/useTheme";
import type { DashboardNavUser } from "../lib/types";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { TwoFactorSettings } from "../components/settings/TwoFactorSettings";

interface AccountSettingsPageProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onBack?: () => void;
  /** Accepted for parity with the server settings route; not currently shown. */
  currentUser?: DashboardNavUser | null;
}

/**
 * Per-user account settings, opened from the header user menu. Holds only things
 * tied to the signed-in user (appearance, two-factor auth) — global/server
 * configuration lives on the separate Server settings page.
 */
export function AccountSettingsPage({ themeMode, onThemeChange, onBack }: AccountSettingsPageProps) {
  return (
    <ContentLayout>
      <div className="vantyr-admin-page vantyr-settings-page sx-console">
        <SpaceBetween size="l">
          <Header
            variant="h1"
            description="Settings for your own dashboard sign-in. These apply only to you — not to other users or the server."
            actions={
              onBack ? (
                <Button iconName="angle-left" onClick={onBack}>
                  Back
                </Button>
              ) : undefined
            }
          >
            Account settings
          </Header>

          <AppearanceSettings themeMode={themeMode} onThemeChange={onThemeChange} />

          <TwoFactorSettings />
        </SpaceBetween>
      </div>
    </ContentLayout>
  );
}
