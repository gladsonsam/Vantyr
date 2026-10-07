import type { Control } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberField } from "@/components/common/form/fields";
import { parseRetentionDays, type RetentionValues } from "./lib/retention";

interface DataRetentionSettingsProps {
  control: Control<RetentionValues>;
  isAdmin?: boolean;
}

export function DataRetentionSettings({ control, isAdmin = false }: DataRetentionSettingsProps) {
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
        <NumberField
          control={control}
          name="keylog_days"
          id="retention-keylog"
          label="Keystrokes retention (days)"
          aria-label="Keystrokes retention (days)"
          inputMode="numeric"
          disabled={!isAdmin}
          parse={parseRetentionDays}
          className="h-9"
          description="0 = keep all keystroke sessions."
        />
        <NumberField
          control={control}
          name="window_days"
          id="retention-windows"
          label="Windows/activity retention (days)"
          aria-label="Windows/activity retention (days)"
          inputMode="numeric"
          disabled={!isAdmin}
          parse={parseRetentionDays}
          className="h-9"
          description="0 = keep all window and AFK/active events."
        />
        <NumberField
          control={control}
          name="url_days"
          id="retention-urls"
          label="URLs retention (days)"
          aria-label="URLs retention (days)"
          inputMode="numeric"
          disabled={!isAdmin}
          parse={parseRetentionDays}
          className="h-9"
          description="0 = keep all URL visit rows."
        />
      </CardContent>
    </Card>
  );
}
