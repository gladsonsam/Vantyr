import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { RecallSettingsFields } from "./RecallSettingsFields";
import { api, errorText } from "@/api";
import { moduleQueries } from "@/api/queries/modules";
import { recallKeys, recallQueries } from "@/api/queries/recall";
import { useServerDraft } from "@/hooks/useServerDraft";
import { deviceCaptureState, sameRecallSettings, type CaptureTone } from "@/features/recall/lib/captureStatus";
import { cn } from "@/lib/utils";
import type { AgentRecallSettings as Layers, DeviceModuleStatus, RecallSettings } from "@/api/types";

type Mode = "inherit" | "custom";

/** The server sends changed capture settings to a connected device right away. */
const SENT = "A connected device is sent it now; others get it when they next connect.";

/**
 * Per-agent Recall capture override.
 *
 * Two explicit modes rather than per-field override switches, because the server's
 * PUT replaces the whole override row: a field left out means "inherit", so a
 * half-filled patch would silently reset the fields it didn't mention. Choosing
 * "Custom" starts from what the agent is currently running, so switching
 * modes never changes behaviour on its own — only saving does.
 */
export function AgentRecallSettings({ agentId, isAdmin, canOperate = true }: { agentId: string; isAdmin: boolean; canOperate?: boolean }) {
  // Keyed by agent so a draft, message or error never carries over to another device.
  return <AgentRecallForm key={agentId} agentId={agentId} isAdmin={isAdmin} canOperate={canOperate} />;
}

function AgentRecallForm({ agentId, isAdmin, canOperate }: { agentId: string; isAdmin: boolean; canOperate: boolean }) {
  const form = useAgentRecallSettingsForm(agentId, isAdmin);
  // The module report is operator-only; viewers never ask. A failed poll just means "unknown".
  const deviceQuery = useQuery({
    ...moduleQueries.status(agentId),
    enabled: canOperate,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  if (form.loading) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
          <Spinner aria-label="Loading capture settings" /> Loading capture settings…
        </CardContent>
      </Card>
    );
  }
  if (!form.layers) {
    return <LoadFailedCard message={form.error ?? "Capture settings are unavailable."} onRetry={form.reload} />;
  }

  const { layers, mode, draft } = form;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-5 p-5 text-sm">
        <CaptureSummary layers={layers} status={deviceQuery.data ?? null} canOperate={canOperate} />

        {form.error && (
          <Alert variant="destructive">
            <AlertDescription>{form.error}</AlertDescription>
          </Alert>
        )}
        {form.saved && !form.error && (
          <p role="status" className="text-success">
            {form.saved}
          </p>
        )}

        <ToggleGroup
          size="sm"
          spacing={0}
          className="w-fit max-w-full rounded-lg bg-muted/70 p-0.5"
          aria-label="Capture settings mode"
          value={[mode]}
          disabled={form.saving || !isAdmin}
          onValueChange={(value) => {
            const next = value[0] as Mode | undefined;
            if (next) form.chooseMode(next);
          }}
        >
          <ToggleGroupItem value="inherit" aria-label="Fleet defaults" className="rounded-md! px-2.5 aria-pressed:bg-background pointer-coarse:h-9">
            Fleet defaults
          </ToggleGroupItem>
          <ToggleGroupItem value="custom" aria-label="Custom" className="rounded-md! px-2.5 aria-pressed:bg-background pointer-coarse:h-9">
            Custom
          </ToggleGroupItem>
        </ToggleGroup>

        <RecallSettingsFields
          value={mode === "custom" ? draft : layers.global}
          defaults={mode === "custom" ? layers.global : undefined}
          recordNote={null}
          onChange={form.edit}
          disabled={!isAdmin || form.saving || mode === "inherit"}
        />

        <CaptureSaveAction isAdmin={isAdmin} form={form} />
      </CardContent>
    </Card>
  );
}

const TONE: Record<CaptureTone, { Icon: typeof Info; className: string }> = {
  success: { Icon: CircleCheck, className: "text-success" },
  warning: { Icon: CircleAlert, className: "text-warning" },
  muted: { Icon: Info, className: "text-muted-foreground" },
};

/** What is saved (the request) above what the device itself reports (its permission), kept apart. */
function CaptureSummary({ layers, status, canOperate }: { layers: Layers; status: DeviceModuleStatus | null; canOperate: boolean }) {
  const effective = layers.effective ?? layers.global;
  const device = deviceCaptureState(effective.enabled, status, canOperate);
  const { Icon, className } = TONE[device.tone];
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-base font-medium">
        {effective.enabled ? "Saved: record this screen" : "Saved: do not record"} · {layers.override ? "custom for this device" : "fleet defaults"}
      </h3>
      <p className={cn("flex items-start gap-2", className)}>
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{device.text}</span>
      </p>
    </div>
  );
}

function useAgentRecallSettingsForm(agentId: string, isAdmin: boolean) {
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
  const [saved, setSaved] = useState<string | null>(null);

  const saveSettings = useMutation({
    mutationFn: async (next: { mode: Mode; draft: RecallSettings }) => {
      if (next.mode === "inherit") {
        await api.agentRecallSettingsDelete(agentId);
        return `Using fleet defaults. ${SENT}`;
      }
      await api.agentRecallSettingsPut(agentId, next.draft);
      return `Saved. ${SENT}`;
    },
    onMutate: () => setSaved(null),
    onSuccess: (message) => {
      setSaved(message);
      void queryClient.invalidateQueries({ queryKey: recallKeys.agentSettings(agentId) });
    },
  });
  const failure = saveSettings.error ?? layersQuery.error;

  // What is saved on the server, to tell what has been changed here.
  const savedMode: Mode = layers?.override ? "custom" : "inherit";
  const savedDraft = layers ? (layers.effective ?? layers.global) : null;
  const dirty = Boolean(layers && draft && savedDraft) && (mode !== savedMode || (mode === "custom" && !sameRecallSettings(draft!, savedDraft!)));

  return {
    layers,
    mode,
    draft: draft as RecallSettings,
    savedMode,
    dirty,
    loading: layersQuery.isPending,
    saved,
    saving: saveSettings.isPending,
    error: failure ? errorText(failure) : null,
    reload: () => void layersQuery.refetch(),
    chooseMode: (next: Mode) => {
      setSaved(null);
      saveSettings.reset();
      setForm((prev) => ({ ...prev, mode: next }));
    },
    edit: (patch: Partial<RecallSettings>) => {
      setSaved(null);
      saveSettings.reset();
      setForm((prev) => ({ ...prev, draft: prev.draft ? { ...prev.draft, ...patch } : prev.draft }));
    },
    discard: () => {
      setSaved(null);
      saveSettings.reset();
      if (layers) setForm({ mode: savedMode, draft: savedDraft });
    },
    save: () => {
      if (!isAdmin || !draft || !dirty) return;
      saveSettings.mutate({ mode, draft });
    },
  };
}

type RecallForm = ReturnType<typeof useAgentRecallSettingsForm>;

function CaptureSaveAction({ isAdmin, form }: { isAdmin: boolean; form: RecallForm }) {
  if (!isAdmin) return <p className="text-muted-foreground">Only admins can change capture settings.</p>;
  const { mode, savedMode, dirty, saving } = form;
  // Say what saving does to the link with the fleet defaults only when that is about to change.
  const consequence =
    mode === "custom" && savedMode === "inherit"
      ? "Saving keeps these values for this device only: later changes to the fleet defaults will not apply to it."
      : mode === "inherit" && savedMode === "custom"
        ? "Saving drops this device's custom values: it follows the fleet defaults again."
        : null;
  return (
    <div className="flex flex-col gap-3">
      {consequence && <p className="text-muted-foreground">{consequence}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={form.save} disabled={saving || !dirty}>
          {saving && <Spinner />} {saving ? "Saving…" : mode === "inherit" ? "Use fleet defaults" : "Save"}
        </Button>
        {dirty && (
          <Button variant="outline" disabled={saving} onClick={form.discard}>
            Discard changes
          </Button>
        )}
      </div>
    </div>
  );
}
