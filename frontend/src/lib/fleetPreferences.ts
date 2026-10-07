import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "@/api";
import { buildApiUrl } from "@/api/serverSettings";
import { parseFleetSort, type FleetSort } from "./fleetSort";

export type FleetStatusFilter = "all" | "online" | "offline" | "active" | "afk";
export interface SavedFleetView {
  name: string;
  search: string;
  status: FleetStatusFilter;
  view: "grid" | "table";
  sort: FleetSort;
  favoritesOnly: boolean;
}
export interface FleetPreferences { favorites: string[]; views: SavedFleetView[] }
const EMPTY: FleetPreferences = { favorites: [], views: [] };
const CHANGE = "vantyr:fleet-preferences";
const fallback = new Map<string, string>();
export function fleetPreferenceScope(server: string, userId: string) {
  return `vantyr.fleet-preferences.v1:${JSON.stringify([server, userId])}`;
}
export function fleetServerScope() {
  try { return new URL(buildApiUrl("/"), window.location.href).href; } catch { return ""; }
}
export function parseFleetPreferences(raw: string | null): FleetPreferences {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!data || typeof data !== "object") return EMPTY;
    const { favorites, views } = data as Partial<FleetPreferences>;
    const validViews = Array.isArray(views) ? views.filter((v): v is SavedFleetView => {
      if (!v || typeof v !== "object") return false;
      return typeof v.name === "string" && v.name.trim().length > 0 && v.name.length <= 80 &&
        typeof v.search === "string" && v.search.length <= 512 &&
        ["all", "online", "offline", "active", "afk"].includes(v.status) &&
        ["grid", "table"].includes(v.view) && typeof v.favoritesOnly === "boolean" &&
        v.sort != null && ["connectivity", "name", "last_seen", "first_seen", "agent_version"].includes(v.sort.key) &&
        ["asc", "desc"].includes(v.sort.direction);
    }).slice(0, 20).map((v) => ({ name: v.name.trim(), search: v.search, status: v.status, view: v.view, favoritesOnly: v.favoritesOnly, sort: parseFleetSort(JSON.stringify(v.sort)) })) : [];
    return {
      favorites: Array.isArray(favorites) ? [...new Set(favorites.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128))].slice(0, 10000) : [],
      views: validViews.filter((view, i, list) => list.findIndex((other) => other.name === view.name) === i),
    };
  } catch { return EMPTY; }
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback); window.addEventListener(CHANGE, callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener(CHANGE, callback); };
}
function read(scope: string | null) {
  if (!scope) return null;
  if (fallback.has(scope)) return fallback.get(scope)!;
  try { return localStorage.getItem(scope); } catch { return null; }
}
export function useFleetPreferences(scope: string | null) {
  const raw = useSyncExternalStore(subscribe, () => read(scope), () => null);
  const update = useCallback((change: (previous: FleetPreferences) => FleetPreferences) => {
    if (!scope) return;
    const previous = read(scope);
    const next = JSON.stringify(change(parseFleetPreferences(previous)));
    if (next === previous) return;
    try { localStorage.setItem(scope, next); fallback.delete(scope); } catch { fallback.set(scope, next); }
    window.dispatchEvent(new Event(CHANGE));
  }, [scope]);
  const preferences = useMemo(() => parseFleetPreferences(raw), [raw]);
  return [preferences, update] as const;
}
/**
 * Verified dashboard user for `server`, re-checked on focus. The last verified user stays in place while
 * re-checking so unchanged identities never reset scoped state; it is replaced on a different user and
 * cleared on server change or session expiry (401 dispatches `vantyr-session-expired`).
 */
export function useVerifiedUser(server: string) {
  const [identity, setIdentity] = useState<{ server: string; user: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let pending: AbortController | null = null;
    const verify = () => {
      if (pending || !server || typeof api.me !== "function") return;
      const request = ++generation;
      const controller = new AbortController(); pending = controller;
      void api.me(controller.signal).then((user) => {
        if (!alive || request !== generation || fleetServerScope() !== server) return;
        const next = typeof user.id === "string" && user.id ? user.id : null;
        setIdentity((previous) => next === null ? null : previous?.server === server && previous.user === next ? previous : { server, user: next });
      }).catch(() => {}).finally(() => { if (pending === controller) pending = null; });
    };
    const expire = () => { ++generation; pending?.abort(); pending = null; setIdentity(null); };
    verify();
    window.addEventListener("focus", verify);
    window.addEventListener("vantyr-session-expired", expire);
    return () => { alive = false; ++generation; pending?.abort(); pending = null; window.removeEventListener("focus", verify); window.removeEventListener("vantyr-session-expired", expire); };
  }, [server]);
  return identity?.server === server ? identity.user : null;
}
/** One identity request per fleet context/focus; never an identity request per row. */
export function useFleetPreferenceScope() {
  const server = useSyncExternalStore(subscribe, fleetServerScope, () => "");
  const user = useVerifiedUser(server);
  return user ? fleetPreferenceScope(server, user) : null;
}
