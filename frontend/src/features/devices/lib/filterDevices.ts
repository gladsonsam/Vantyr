import type { FleetStatusFilter } from "@/features/fleet/lib/fleetPreferences";
import type { DeviceRow } from "./deviceModel";
import { connectedCount } from "./deviceModel";

/**
 * Applies the Devices page's filters to devices that have no agent, so they react to the same search,
 * status tabs and favourites as the agent cards beside them. Favourites belong to agents today, so a
 * favourites-only view shows none of these.
 */
export function filterDevices(
  rows: DeviceRow[],
  filters: { query: string; status: FleetStatusFilter; favoritesOnly: boolean },
): DeviceRow[] {
  if (filters.favoritesOnly) return [];
  const needle = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (needle) {
      const haystack = [row.label, ...row.people.map((p) => p.person.display_name)]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    const live = connectedCount(row) > 0;
    switch (filters.status) {
      case "all":
        return true;
      case "online":
      case "active":
        return live;
      case "offline":
        return !live;
      // "Away" is the agent's own idea of an idle user; other connections have no such state.
      case "afk":
        return false;
    }
  });
}
