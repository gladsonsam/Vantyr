import { Box, Container, FormField, Input, SpaceBetween } from "../ui/console";

interface DataRetentionSettingsProps {
  retention: { keylog_days: number; window_days: number; url_days: number };
  onChange: (patch: Partial<{ keylog_days: number; window_days: number; url_days: number }>) => void;
}

export function DataRetentionSettings({ retention, onChange }: DataRetentionSettingsProps) {
  return (
    <Container header="Data retention">
      <SpaceBetween size="s">
        <Box fontSize="body-s" color="text-body-secondary">
          Set to <Box variant="code">0</Box> for unlimited retention (no automatic prune) for that category. Values 1-36500
          delete raw rows older than that many days. Top URL/window aggregates are kept separately.
        </Box>
        <FormField label="Keystrokes retention (days)" description="0 = keep all keystroke sessions.">
          <Input
            type="number"
            inputMode="numeric"
            value={String(retention.keylog_days)}
            onChange={({ detail }) =>
              onChange({
                keylog_days: Math.max(0, Math.min(36500, Number(detail.value) || 0)),
              })
            }
          />
        </FormField>
        <FormField label="Windows/activity retention (days)" description="0 = keep all window and AFK/active events.">
          <Input
            type="number"
            inputMode="numeric"
            value={String(retention.window_days)}
            onChange={({ detail }) =>
              onChange({
                window_days: Math.max(0, Math.min(36500, Number(detail.value) || 0)),
              })
            }
          />
        </FormField>
        <FormField label="URLs retention (days)" description="0 = keep all URL visit rows.">
          <Input
            type="number"
            inputMode="numeric"
            value={String(retention.url_days)}
            onChange={({ detail }) =>
              onChange({
                url_days: Math.max(0, Math.min(36500, Number(detail.value) || 0)),
              })
            }
          />
        </FormField>
      </SpaceBetween>
    </Container>
  );
}
