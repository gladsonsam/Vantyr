import { buildApiUrl } from "../../lib/serverSettings";

export type SavedSearch = { query: string; scope: "retained" | "range"; sort: "ranked" | "newest"; from?: string; to?: string; monitor: number | null };
export type Bookmark = { id: string; at: string; monitor: number | null; note: string; frameId: number };
export function preferenceKey(userId: string, agentId: string): string {
  return `vantyr-recall-v1:${JSON.stringify([new URL(buildApiUrl("/"), location.origin).href, userId, agentId])}`;
}
export function readItems<T>(key: string): T[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.slice(0, 100) as T[] : []; } catch { return []; }
}
export function writeItems<T>(key: string, items: T[]): boolean {
  try { localStorage.setItem(key, JSON.stringify(items.slice(0, 100))); return true; } catch { return false; }
}

/** Resolve a wall clock in an IANA zone. Reject DST gaps and ambiguous repeated times. */
export function deviceTime(value: string, timezone: string | null): number | null {
  if (!timezone || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const target = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 19) !== normalized) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const wall = (ms: number) => { const p = Object.fromEntries(fmt.formatToParts(ms).map(p => [p.type, p.value])); return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); };
    const offsets = new Set([-86400000, 0, 86400000].map(delta => wall(target + delta) - (target + delta)));
    const matches = [...offsets].map(offset => target - offset).filter(ms => wall(ms) === target);
    return matches.length === 1 ? matches[0] : null;
  } catch { return null; }
}
