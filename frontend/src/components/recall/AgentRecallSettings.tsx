import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Box, Button, Container, SegmentedControl, SpaceBetween, Spinner } from "../ui/console";
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
      <Container header="Recall capture">
        <Spinner />
      </Container>
    );
  }
  if (!layers || !draft) {
    return (
      <Container header="Recall capture">
        <Box color="text-body-secondary" fontSize="body-s">
          {error ?? "Capture settings are unavailable."}
        </Box>
      </Container>
    );
  }

  const effective = layers.effective ?? layers.global;

  return (
    <Container header="Recall capture">
      <SpaceBetween size="s">
        <Box fontSize="body-s" color="text-body-secondary">
          How much of this machine's screen is recorded. Currently{" "}
          {effective.enabled ? (
            <Badge color="green">recording</Badge>
          ) : (
            <Badge color="red">not recording</Badge>
          )}{" "}
          {layers.override ? (
            <Badge color="blue">custom settings</Badge>
          ) : (
            <Badge color="grey">fleet defaults</Badge>
          )}
        </Box>

        {error && <Alert type="error">{error}</Alert>}
        {saved && !error && <Alert type="success">{saved}</Alert>}

        <SegmentedControl
          selectedId={mode}
          onChange={({ detail }) => {
            const next = detail.selectedId as Mode;
            setSaved(null);
            setMode(next);
            // Seed a fresh override from what the agent runs today, so switching to
            // Custom and saving is a no-op until something is actually changed.
            if (next === "custom") setDraft(effective);
          }}
          options={[
            { id: "inherit", text: "Fleet defaults" },
            { id: "custom", text: "Custom for this machine" },
          ]}
        />

        {mode === "inherit" ? (
          <Box fontSize="body-s" color="text-body-secondary">
            This machine follows the fleet-wide capture settings. Changing the fleet defaults
            changes this machine too.
          </Box>
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
            <Button variant="primary" onClick={() => void save()} loading={saving}>
              {mode === "inherit" ? "Follow fleet defaults" : "Save override"}
            </Button>
          </div>
        ) : (
          <Box fontSize="body-s" color="text-body-secondary">
            Only admins can change what this machine records.
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
