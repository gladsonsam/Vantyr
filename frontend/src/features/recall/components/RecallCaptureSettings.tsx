import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { RecallSettingsFields } from "./RecallSettingsFields";
import { api, errorText } from "@/api";
import { recallKeys, recallQueries } from "@/api/queries/recall";
import { sameRecallSettings } from "../lib/captureStatus";
import { HelpTip } from "@/components/common/HelpTip";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import type { RecallSettings } from "@/api/types";

/**
 * Fleet-wide Recall capture settings.
 *
 * These endpoints have existed server-side since the capture-settings migration
 * with no client at all: cadence, quality, OCR and the kill switch were only
 * reachable by hand-rolling HTTP requests, which meant that in practice the fleet
 * ran whatever the defaults were and "stop recording this machine" wasn't a thing
 * an operator could do.
 *
 * Edits sit beside the saved copy (`null` = untouched) so a retry or refresh never overwrites what is
 * being typed; the saved copy is only ever what the server returned.
 */
function useCaptureSettings(isAdmin: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery(recallQueries.settings());
  const saved = query.data ?? null;
  const [edits, setEdits] = useState<RecallSettings | null>(null);
  const settings = edits ?? saved;
  const dirty = Boolean(edits && saved && !sameRecallSettings(edits, saved));

  const mutation = useMutation({
    mutationFn: (next: RecallSettings) => api.recallSettingsPut(next),
    onSuccess: (stored) => {
      // The response is the stored row, so the form reflects what the server kept
      // rather than what was typed at it.
      queryClient.setQueryData(recallKeys.settings(), stored);
      setEdits(null);
    },
  });

  return {
    query,
    saved,
    settings,
    dirty,
    saving: mutation.isPending,
    saveError: mutation.error ? errorText(mutation.error) : null,
    justSaved: mutation.isSuccess && !dirty,
    edit: (patch: Partial<RecallSettings>) => {
      if (!settings) return;
      if (mutation.isSuccess || mutation.isError) mutation.reset();
      setEdits({ ...settings, ...patch });
    },
    discard: () => {
      mutation.reset();
      setEdits(null);
    },
    save: () => {
      if (!isAdmin || !settings || !dirty) return;
      mutation.mutate(settings);
    },
  };
}

type CaptureForm = ReturnType<typeof useCaptureSettings>;

function CaptureNotices({ form }: { form: CaptureForm }) {
  const { query } = form;
  return (
    <>
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn&apos;t refresh these settings, so they may be out of date.</span>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {form.saveError && (
        <Alert variant="destructive">
          <AlertDescription>Not saved. {form.saveError}</AlertDescription>
        </Alert>
      )}
      {form.justSaved && (
        <p role="status" className="text-sm text-success">
          Saved. Connected devices were sent the new defaults.
        </p>
      )}
    </>
  );
}

function CaptureActions({ form, isAdmin }: { form: CaptureForm; isAdmin: boolean }) {
  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">Only admins can change capture settings.</p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={form.saving || !form.dirty} onClick={form.save}>
        {form.saving && <Spinner />} Save capture settings
      </Button>
      {form.dirty && (
        <Button variant="outline" disabled={form.saving} onClick={form.discard}>
          Discard changes
        </Button>
      )}
      {form.dirty && !form.saving && (
        <span className="text-sm text-muted-foreground">Unsaved changes</span>
      )}
    </div>
  );
}

export function RecallCaptureSettings({ isAdmin }: { isAdmin: boolean }) {
  const form = useCaptureSettings(isAdmin);
  const { query, saved, settings } = form;

  if (query.isPending) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="flex items-center justify-center gap-2 p-5 py-8 text-sm text-muted-foreground">
          <Spinner /> Loading capture settings…
        </CardContent>
      </Card>
    );
  }
  // No form without the saved values: defaults shown as if they were saved would be saved over the real ones.
  if (!settings || !saved) {
    return (
      <LoadFailedCard
        message={
          query.error
            ? `Couldn't load capture settings. ${errorText(query.error)}`
            : "Capture settings are unavailable."
        }
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border/70 px-5 py-4">
        <CardTitle className="flex items-center gap-1.5">
          Screen history capture
          <HelpTip>
            Defaults for every device&apos;s screen history. A device can override any of these from
            its own Settings tab.
          </HelpTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        <p className="text-sm text-muted-foreground">
          {saved.enabled
            ? "Screens are recorded by default."
            : "Screens are not recorded by default."}
        </p>
        <CaptureNotices form={form} />
        <RecallSettingsFields
          value={settings}
          onChange={form.edit}
          disabled={!isAdmin || form.saving}
        />
        <CaptureActions form={form} isAdmin={isAdmin} />
      </CardContent>
    </Card>
  );
}
