import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface DataRetentionSettingsProps {
  retention: { keylog_days: number; window_days: number; url_days: number };
  onChange: (patch: Partial<{ keylog_days: number; window_days: number; url_days: number }>) => void;
  isAdmin?: boolean;
}

export function DataRetentionSettings({ retention, onChange, isAdmin = false }: DataRetentionSettingsProps) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Data retention</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        {!isAdmin && (
          <p className="text-sm text-muted-foreground">
            View-only — an administrator role is required to change retention.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Set to <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px]">0</code> for
          unlimited retention (no automatic prune) for that category. Values 1-36500
          delete raw rows older than that many days. Top URL/window aggregates are kept separately.
        </p>
        <Field>
          <FieldLabel htmlFor="retention-keylog">Keystrokes retention (days)</FieldLabel>
          <Input
            id="retention-keylog"
            aria-label="Keystrokes retention (days)"
            type="number"
            inputMode="numeric"
            disabled={!isAdmin}
            value={String(retention.keylog_days)}
            onChange={(event) =>
              onChange({
                keylog_days: Math.max(0, Math.min(36500, Number(event.target.value) || 0)),
              })
            }
            className="h-9"
          />
          <FieldDescription>0 = keep all keystroke sessions.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="retention-windows">Windows/activity retention (days)</FieldLabel>
          <Input
            id="retention-windows"
            aria-label="Windows/activity retention (days)"
            type="number"
            inputMode="numeric"
            disabled={!isAdmin}
            value={String(retention.window_days)}
            onChange={(event) =>
              onChange({
                window_days: Math.max(0, Math.min(36500, Number(event.target.value) || 0)),
              })
            }
            className="h-9"
          />
          <FieldDescription>0 = keep all window and AFK/active events.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="retention-urls">URLs retention (days)</FieldLabel>
          <Input
            id="retention-urls"
            aria-label="URLs retention (days)"
            type="number"
            inputMode="numeric"
            disabled={!isAdmin}
            value={String(retention.url_days)}
            onChange={(event) =>
              onChange({
                url_days: Math.max(0, Math.min(36500, Number(event.target.value) || 0)),
              })
            }
            className="h-9"
          />
          <FieldDescription>0 = keep all URL visit rows.</FieldDescription>
        </Field>
      </CardContent>
    </Card>
  );
}
