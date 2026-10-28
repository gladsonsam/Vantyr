import type { Control } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { NumberField } from "@/components/common/form/fields";
import { parseRetentionDays, type RetentionValues } from "./lib/retention";
import { HelpTip } from "@/components/common/HelpTip";

interface DataRetentionSettingsProps {
  control: Control<RetentionValues>;
  isAdmin?: boolean;
}

export function DataRetentionSettings({ control, isAdmin = false }: DataRetentionSettingsProps) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-1.5">Data retention<HelpTip>Days to keep raw rows, from 1 to 36500; 0 keeps them forever. Top URL and window totals are kept separately.</HelpTip></CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        {!isAdmin && <p className="text-sm text-muted-foreground">Admins only.</p>}
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
