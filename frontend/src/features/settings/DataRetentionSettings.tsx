import type { Control } from "react-hook-form";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { NumberField } from "@/components/common/form/fields";
import { parseRetentionDays, type RetentionValues } from "./lib/retention";
import { HelpTip } from "@/components/common/HelpTip";

interface DataRetentionSettingsProps {
  control: Control<RetentionValues>;
  isAdmin?: boolean;
  /** Saves these three values; the card owns its own Save so its scope is obvious. */
  onSave: () => void;
  saving?: boolean;
}

export function DataRetentionSettings({ control, isAdmin = false, onSave, saving = false }: DataRetentionSettingsProps) {
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
          label="Keystrokes (days)"
          aria-label="Keystrokes (days)"
          inputMode="numeric"
          disabled={!isAdmin}
          parse={parseRetentionDays}
          className="h-9"
          description="0 keeps them forever."
        />
        <NumberField
          control={control}
          name="window_days"
          id="retention-windows"
          label="Windows and activity (days)"
          aria-label="Windows and activity (days)"
          inputMode="numeric"
          disabled={!isAdmin}
          parse={parseRetentionDays}
          className="h-9"
          description="0 keeps them forever."
        />
        <NumberField
          control={control}
          name="url_days"
          id="retention-urls"
          label="URLs (days)"
          aria-label="URLs (days)"
          inputMode="numeric"
          disabled={!isAdmin}
          parse={parseRetentionDays}
          className="h-9"
          description="0 keeps them forever."
        />
        {isAdmin && (
          <div>
            <Button onClick={onSave} disabled={saving}>
              {saving && <Spinner />} Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
