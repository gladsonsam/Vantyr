import { useEffect } from "react";
import { api, SETTINGS_VERSION_POLL_INTERVAL_MS } from "../lib/api";

/**
 * Keeps `useServerVersionPayload()` fresh while the authenticated dashboard
 * shell is mounted. Pass `enabled=false` (e.g. while signed out) to avoid
 * polling the version endpoint on the login screen.
 */
export function usePollDashboardServerVersion(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const load = () => {
      void api.settingsVersionGet().catch(() => {});
    };
    load();
    const id = window.setInterval(load, SETTINGS_VERSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
}
