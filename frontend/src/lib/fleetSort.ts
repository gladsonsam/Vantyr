import { useSyncExternalStore } from "react";

export type FleetSort = { key: "connectivity" | "name"; direction: "asc" | "desc" };
export const DEFAULT_FLEET_SORT: FleetSort = { key: "connectivity", direction: "asc" };
const STORAGE_KEY = "vantyr.fleet-sort.v1";
const CHANGE_EVENT = "vantyr:fleet-sort";
const naturalName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function parseFleetSort(raw: string | null): FleetSort {
  try {
    const value = JSON.parse(raw ?? "null");
    if ((value?.key === "connectivity" || value?.key === "name") &&
        (value.direction === "asc" || value.direction === "desc")) return value;
  } catch { /* Invalid preferences use the default. */ }
  return DEFAULT_FLEET_SORT;
}

function snapshot() {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}
// Keep preferences usable for this session when browser storage is unavailable.
let sessionPreference: string | null = null;
function getSnapshot() { return sessionPreference ?? snapshot(); }
export function useFleetSort() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return [parseFleetSort(raw), (sort: FleetSort) => {
    const next = JSON.stringify(sort);
    try { window.localStorage.setItem(STORAGE_KEY, next); sessionPreference = null; }
    catch { sessionPreference = next; }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }] as const;
}

export function sortFleet<T extends { id: string; name: string; displayName?: string; online: boolean }>(
  agents: readonly T[], sort: FleetSort = DEFAULT_FLEET_SORT,
): T[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...agents].sort((a, b) => {
    const connectivity = sort.key === "connectivity" ? Number(b.online) - Number(a.online) : 0;
    const name = naturalName.compare((a.displayName ?? a.name).trim() || a.id, (b.displayName ?? b.name).trim() || b.id);
    // IDs always break equivalent names deterministically, independent of insertion order.
    return direction * (connectivity || name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
