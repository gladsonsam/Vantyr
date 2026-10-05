import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="flex flex-col gap-8">
      {onBack ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-8">
        <AppearanceSettings themeMode={themeMode} onThemeChange={onThemeChange} />

        <TwoFactorSettings />
      </div>
    </div>
  );
}
