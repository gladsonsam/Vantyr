import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { RecallSettingsFields } from "./RecallSettingsFields";
import { api, errorText } from "@/api";
import { recallKeys, recallQueries } from "@/api/queries/recall";
import { useServerDraft } from "@/hooks/useServerDraft";
import type { RecallSettings } from "@/api/types";

/**
 * Fleet-wide Recall capture settings.
 *
 * These endpoints have existed server-side since the capture-settings migration
 * with no client at all: cadence, quality, OCR and the kill switch were only
 * reachable by hand-rolling HTTP requests, which meant that in practice the fleet
 * ran whatever the defaults were and "stop recording this machine" wasn't a thing
 * an operator could do.
 */
export function RecallCaptureSettings({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(recallQueries.settings());
  const [settings, setSettings] = useServerDraft<RecallSettings, RecallSettings | null>(
    settingsQuery.data,
    settingsQuery.dataUpdatedAt,
    (s) => s,
    null,
  );
  const loading = settingsQuery.isPending;
  const [saved, setSaved] = useState(false);

  const saveSettings = useMutation({
    mutationFn: (next: RecallSettings) => api.recallSettingsPut(next),
    onMutate: () => setSaved(false),
    onSuccess: (stored) => {
      // The response is the stored row, so the form reflects what the server kept
      // rather than what was typed at it.
      queryClient.setQueryData(recallKeys.settings(), stored);
      setSaved(true);
    },
  });
  const saving = saveSettings.isPending;
  const failure = saveSettings.error ?? settingsQuery.error;
  const error = failure ? errorText(failure) : null;

  const save = () => {
    if (!isAdmin) return;
    if (!settings) return;
    saveSettings.mutate(settings);
  };

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Recall capture</CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading capture settings…
          </div>
        ) : !settings ? (
          <p className="text-sm text-muted-foreground">
            {error ?? "Capture settings are unavailable."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Fleet defaults for screen-history capture. Individual machines can override any of
              these from their own Settings tab.
            </p>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {saved && !error && (
              <Alert>
                <AlertDescription className="text-success">
                  Capture settings saved and pushed to connected agents.
                </AlertDescription>
              </Alert>
            )}

            <RecallSettingsFields
              value={settings}
              onChange={(patch) => {
                setSaved(false);
                setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
              }}
              disabled={!isAdmin || saving}
            />

            {isAdmin ? (
              <div>
                <Button disabled={saving} onClick={save}>
                  {saving && <Spinner />} Save capture settings
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Only admins can change capture settings — this controls how much every machine in
                the fleet records.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
