import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RecallSettingsFields } from "./RecallSettingsFields";
import { api, errorText } from "../../lib/api";
import type { AgentRecallSettings as Layers, RecallSettings } from "../../lib/types";

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
  const [layers, setLayers] = useState<Layers | null>(null);
  const [draft, setDraft] = useState<RecallSettings | null>(null);
  const [mode, setMode] = useState<Mode>("inherit");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    api
      .agentRecallSettingsGet(agentId)
      .then((res) => {
        if (!alive) return;
        setLayers(res);
        setMode(res.override ? "custom" : "inherit");
        setDraft(res.effective ?? res.global);
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [agentId]);

  useEffect(() => load(), [load]);

  const save = async () => {
    if (!isAdmin) return;
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      if (mode === "inherit") {
        await api.agentRecallSettingsDelete(agentId);
        setSaved("This machine now follows the fleet defaults.");
      } else {
        await api.agentRecallSettingsPut(agentId, draft);
        setSaved("Override saved and pushed to the agent.");
      }
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
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
            {error ?? "Capture settings are unavailable."}
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
          How much of this machine&apos;s screen is recorded. Currently{" "}
          {effective.enabled ? (
            <span className="font-medium text-success">recording</span>
          ) : (
            <span className="font-medium text-destructive">not recording</span>
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
          <ToggleGroupItem value="custom" aria-label="Custom for this machine" className="rounded-md! px-2.5 aria-pressed:bg-background">
            Custom for this machine
          </ToggleGroupItem>
        </ToggleGroup>

        {mode === "inherit" ? (
          <p className="text-sm text-muted-foreground">
            This machine follows the fleet-wide capture settings. Changing the fleet defaults
            changes this machine too.
          </p>
        ) : null}

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
            <Button onClick={() => void save()} disabled={saving}>
              {saving
                ? "Saving…"
                : mode === "inherit"
                  ? "Follow fleet defaults"
                  : "Save override"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only admins can change what this machine records.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
