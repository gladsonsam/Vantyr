import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import type { ThemeMode } from "@/hooks/useTheme";

interface AppearanceSettingsProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

export function AppearanceSettings({ themeMode, onThemeChange }: AppearanceSettingsProps) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Appearance &amp; connection</CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <Field>
          <FieldLabel htmlFor="appearance-theme">Theme</FieldLabel>
          <Select
            value={themeMode}
            onValueChange={(value) => onThemeChange(value as ThemeMode)}
          >
            <SelectTrigger id="appearance-theme" className="h-9 w-full sm:max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>Applied immediately and persisted in browser storage.</FieldDescription>
        </Field>
      </CardContent>
    </Card>
  );
}
