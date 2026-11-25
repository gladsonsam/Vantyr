import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { HelpTip } from "@/components/common/HelpTip";
import type { ThemeMode } from "@/hooks/useTheme";

interface AppearanceSettingsProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

const THEME_OPTIONS: { label: string; value: ThemeMode; icon: LucideIcon }[] = [
  { label: "System", value: "system", icon: Monitor },
  { label: "Light", value: "light", icon: Sun },
  { label: "Dark", value: "dark", icon: Moon },
];

/** Your own theme: one press to switch, always one option chosen. Remembered in this browser only. */
export function AppearanceSettings({ themeMode, onThemeChange }: AppearanceSettingsProps) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-3">
        <CardTitle className="flex items-center gap-1.5">
          Appearance
          <HelpTip>Applies only to you, and is remembered in this browser. System follows your device’s light or dark setting.</HelpTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <ToggleGroup
          size="lg"
          spacing={0}
          aria-label="Theme"
          className="w-full rounded-lg bg-muted/70 p-0.5 sm:w-fit"
          value={[themeMode]}
          onValueChange={(value) => {
            // Pressing the chosen option again would deselect it; a theme is always set.
            const next = value[0] as ThemeMode | undefined;
            if (next) onThemeChange(next);
          }}
        >
          {THEME_OPTIONS.map(({ label, value, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value} className="flex-1 gap-1.5 rounded-md! px-3 pointer-coarse:h-10 sm:flex-none aria-pressed:bg-background">
              <Icon aria-hidden="true" /> {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardContent>
    </Card>
  );
}
