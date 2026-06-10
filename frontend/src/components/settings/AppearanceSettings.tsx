import { Container, FormField, Select, SpaceBetween } from "../ui/console";
import type { ThemeMode } from "../../hooks/useTheme";

interface AppearanceSettingsProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

const THEME_SELECT_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

export function AppearanceSettings({ themeMode, onThemeChange }: AppearanceSettingsProps) {
  return (
    <Container header="Appearance & connection">
      <SpaceBetween size="l">
        <FormField
          label="Theme"
          description="Applied immediately and persisted in browser storage."
        >
          <Select
            selectedOption={
              THEME_SELECT_OPTIONS.find((o) => o.value === themeMode) ??
              THEME_SELECT_OPTIONS[0]
            }
            onChange={({ detail }) => {
              const val = detail.selectedOption.value as ThemeMode | undefined;
              if (val) onThemeChange(val);
            }}
            options={THEME_SELECT_OPTIONS}
          />
        </FormField>
      </SpaceBetween>
    </Container>
  );
}
