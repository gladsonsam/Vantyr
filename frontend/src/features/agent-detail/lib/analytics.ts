/** Pure helpers for the Analytics tab: category labels, durations and the summary figures. */

export type CategoryOption = { value: string; label: string };
export type CustomGroup = { id: number; key: string; label: string; hidden: boolean; ut1_keys: string[] };

export function humanizeCategoryKey(key: string): string {
  const raw = (key || "").trim();
  if (!raw) return "—";
  // Title Case words; split on underscores/dashes.
  return raw
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function msToHuman(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

export function stripWww(hostname: string): string {
  const h = (hostname || "").trim();
  if (!h) return "";
  return h.toLowerCase().startsWith("www.") ? h.slice(4) : h;
}

/** Enabled UT1 categories as sorted select options. */
export function toCategoryOptions(res: { categories: { key: string; label?: string; enabled: boolean }[] }): CategoryOption[] {
  return (res.categories ?? [])
    .filter((c) => c.enabled)
    .map((c) => ({ value: c.key, label: c.label?.trim() ? (c.label as string) : humanizeCategoryKey(c.key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Visible custom category groups, sorted by label. */
export function toCustomGroups(res: { rows: { id: number; key: string; label_en: string; hidden: boolean; ut1_keys: string[] }[] }): CustomGroup[] {
  return (res.rows ?? [])
    .filter((r) => !r.hidden)
    .map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label_en,
      hidden: r.hidden,
      ut1_keys: Array.isArray(r.ut1_keys) ? r.ut1_keys : [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface CategoryRow {
  category_key: string;
  category_label: string;
  time_ms: number;
}
export interface SiteRow {
  hostname: string;
  time_ms: number;
  visit_count: number;
}
export interface SessionRow {
  duration_ms: number;
}

export interface AnalyticsSummary {
  totalMs: number;
  visitCount: number;
  topSite: { hostname: string; timeMs: number } | null;
}

/**
 * The headline figures: total browsing time, visit count and the leading site. The total is never
 * smaller than the category times it sits above (the session feed can lag or be capped).
 */
export function summarizeAnalytics(categories: CategoryRow[], sites: SiteRow[], sessions: SessionRow[]): AnalyticsSummary {
  const sessionMs = sessions.reduce((acc, r) => acc + (Number(r.duration_ms) || 0), 0);
  const categoryMs = categories.reduce((acc, r) => acc + (Number(r.time_ms) || 0), 0);
  const visitCount = sites.reduce((acc, r) => acc + (Number(r.visit_count) || 0), 0);

  const site = sites[0];
  const topSite = !site || !(site.hostname || "").trim() ? null : { hostname: stripWww(site.hostname), timeMs: Number(site.time_ms) || 0 };

  return { totalMs: Math.max(sessionMs, categoryMs), visitCount, topSite };
}

