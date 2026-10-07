import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RecallSettingsFields } from "./RecallSettingsFields";
import { api, errorText } from "@/api";
import { recallKeys, recallQueries } from "@/api/queries/recall";
import { useServerDraft } from "@/hooks/useServerDraft";
import type { AgentRecallSettings as Layers, RecallSettings } from "@/api/types";

type Mode = "inherit" | "custom";

/**
 * Per-agent Recall capture override.
 *
 * Two explicit modes rather than per-field override switches, because the server's
 * PUT replaces the whole override row: a field left out means "inherit", so a
 * half-filled patch would silently reset the fields it didn't mention. Choosing
 * "Custom" seeds every value from what the agent is currently running, so switching
 * modes never changes behaviour on its own — only saving does.
 */
export function AgentRecallSettings({
  agentId,
  isAdmin,
}: {
  agentId: string;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const layersQuery = useQuery(recallQueries.agentSettings(agentId));
  const layers: Layers | null = layersQuery.data ?? null;
  // Every fresh server copy resets the mode and the draft to what the agent is running.
  const [form, setForm] = useServerDraft<Layers, { mode: Mode; draft: RecallSettings | null }>(
    layersQuery.data,
    layersQuery.dataUpdatedAt,
    (res) => ({ mode: res.override ? "custom" : "inherit", draft: res.effective ?? res.global }),
    { mode: "inherit", draft: null },
  );
  const { mode, draft } = form;
  const setMode = (next: Mode) => setForm((prev) => ({ ...prev, mode: next }));
  const setDraft = (update: RecallSettings | null | ((prev: RecallSettings | null) => RecallSettings | null)) =>
    setForm((prev) => ({ ...prev, draft: typeof update === "function" ? update(prev.draft) : update }));
  const loading = layersQuery.isFetching;
  const [saved, setSaved] = useState<string | null>(null);

  const saveSettings = useMutation({
    mutationFn: async (next: { mode: Mode; draft: RecallSettings }) => {
      if (next.mode === "inherit") {
        await api.agentRecallSettingsDelete(agentId);
        return "Using fleet defaults.";
      }
      await api.agentRecallSettingsPut(agentId, next.draft);
      return "Saved.";
    },
    onMutate: () => setSaved(null),
    onSuccess: (message) => {
      setSaved(message);
      void queryClient.invalidateQueries({ queryKey: recallKeys.agentSettings(agentId) });
    },
  });
  const saving = saveSettings.isPending;
  const failure = saveSettings.error ?? layersQuery.error;
  const error = failure ? errorText(failure) : null;

  const save = () => {
    if (!isAdmin) return;
    if (!draft) return;
    saveSettings.mutate({ mode, draft });
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recall capture</CardTitle>
        </CardHeader>
        <CardContent>
          <Spinner aria-label="Loading capture settings" />
        </CardContent>
      </Card>
    );
  }
  if (!layers || !draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recall capture</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {error ?? "Settings unavailable."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const effective = layers.effective ?? layers.global;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recall capture</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {effective.enabled ? (
            <span className="font-medium text-success">Recording</span>
          ) : (
            <span className="font-medium text-destructive">Not recording</span>
          )}{" "}
          · {layers.override ? "custom settings" : "fleet defaults"}
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saved && !error && (
          <Alert>
            <AlertDescription>{saved}</AlertDescription>
          </Alert>
        )}

        <ToggleGroup
          size="sm"
          spacing={0}
          className="rounded-lg bg-muted/70 p-0.5"
          aria-label="Capture settings mode"
          value={[mode]}
          onValueChange={(value) => {
            const next = value[0] as Mode | undefined;
            if (!next) return;
            setSaved(null);
            setMode(next);
            // Seed a fresh override from what the agent runs today, so switching to
            // Custom and saving is a no-op until something is actually changed.
            if (next === "custom") setDraft(effective);
          }}
        >
          <ToggleGroupItem value="inherit" aria-label="Fleet defaults" className="rounded-md! px-2.5 aria-pressed:bg-background">
            Fleet defaults
          </ToggleGroupItem>
          <ToggleGroupItem value="custom" aria-label="Custom" className="rounded-md! px-2.5 aria-pressed:bg-background">
            Custom
          </ToggleGroupItem>
        </ToggleGroup>

        <RecallSettingsFields
          value={mode === "custom" ? draft : effective}
          onChange={(patch) => {
            setSaved(null);
            setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
          }}
          disabled={!isAdmin || saving || mode === "inherit"}
        />

        {isAdmin ? (
          <div>
            <Button onClick={save} disabled={saving}>
              {saving
                ? "Saving…"
                : mode === "inherit"
                  ? "Use fleet defaults"
                  : "Save"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Admin only.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
