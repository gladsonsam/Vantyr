import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import type { ReturnToState } from "@/app/DashboardLayout";
import { useAppTheme } from "@/app/providers/useAppTheme";
import { AppearanceSettings } from "./AppearanceSettings";
import { TwoFactorSettings } from "@/features/auth/TwoFactorSettings";

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
    <div className="flex max-w-2xl flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2.5 w-fit pointer-coarse:h-9"
        onClick={() => navigate(from ?? "/", { replace: true })}
      >
        <ArrowLeft /> Back
      </Button>

      <AppearanceSettings themeMode={themeMode} onThemeChange={changeTheme} />
      <TwoFactorSettings />

      <p className="text-sm text-muted-foreground">
        Retention, updates, enrollment and other server-wide options are in{" "}
        <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
          Settings
        </Link>
        .
      </p>
    </div>
  );
}
