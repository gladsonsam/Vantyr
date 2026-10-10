import { useQuery } from "@tanstack/react-query";
import { SETTINGS_VERSION_POLL_INTERVAL_MS } from "@/api";
import { settingsQueries } from "@/api/queries/settings";

/**
 * Keeps `useServerVersionPayload()` fresh while the authenticated dashboard
 * shell is mounted. Pass `enabled=false` (e.g. while signed out) to avoid
 * polling the version endpoint on the login screen.
 */
export function usePollDashboardServerVersion(enabled = true): void {
  // The response is published to the version store by `settingsVersionGet` itself; the query is
  // only the schedule (fetch on sign-in, then every poll interval).
  useQuery({
    ...settingsQueries.versionPoll(),
    enabled,
    refetchInterval: SETTINGS_VERSION_POLL_INTERVAL_MS,
    retry: false,
  });
}
