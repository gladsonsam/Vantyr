import { useEffect, useState } from "react";
import { Alert, Box, Button, Container, SpaceBetween, Spinner } from "../ui/console";
import { RecallSettingsFields } from "../recall/RecallSettingsFields";
import { api, errorText } from "../../lib/api";
import type { RecallSettings } from "../../lib/types";

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
  const [settings, setSettings] = useState<RecallSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .recallSettingsGet()
      .then((s) => alive && setSettings(s))
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // The response is the stored row, so the form reflects what the server kept
      // rather than what was typed at it.
      setSettings(await api.recallSettingsPut(settings));
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container header="Recall capture">
      {loading ? (
        <Spinner />
      ) : !settings ? (
        <Box color="text-body-secondary" fontSize="body-s">
          {error ?? "Capture settings are unavailable."}
        </Box>
      ) : (
        <SpaceBetween size="s">
          <Box fontSize="body-s" color="text-body-secondary">
            Fleet defaults for screen-history capture. Individual machines can override any of
            these from their own Settings tab.
          </Box>

          {error && <Alert type="error">{error}</Alert>}
          {saved && !error && <Alert type="success">Capture settings saved and pushed to connected agents.</Alert>}

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
              <Button variant="primary" onClick={() => void save()} loading={saving}>
                Save capture settings
              </Button>
            </div>
          ) : (
            <Box fontSize="body-s" color="text-body-secondary">
              Only admins can change capture settings — this controls how much every machine in
              the fleet records.
            </Box>
          )}
        </SpaceBetween>
      )}
    </Container>
  );
}
