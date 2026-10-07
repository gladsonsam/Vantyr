import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { ReturnToState } from "@/app/DashboardLayout";
import { useAppTheme } from "@/app/providers/useAppTheme";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { TwoFactorSettings } from "@/components/settings/TwoFactorSettings";

/**
 * Per-user account settings, opened from the header user menu. Holds only things
 * tied to the signed-in user (appearance, two-factor auth) — global/server
 * configuration lives on the separate Server settings page.
 */
export function AccountSettingsPage() {
  const { themeMode, changeTheme } = useAppTheme();
  const location = useLocation();
  const navigate = useNavigate();
  // Back returns to wherever the user menu was opened from.
  const from = (location.state as ReturnToState)?.from;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate(from ?? "/", { replace: true })}>
          <ArrowLeft /> Back
        </Button>
      </div>

      <div className="flex flex-col gap-8">
        <AppearanceSettings themeMode={themeMode} onThemeChange={changeTheme} />

        <TwoFactorSettings />
      </div>
    </div>
  );
}
