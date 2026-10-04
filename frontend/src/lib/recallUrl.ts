import { parseRecallFilters } from "./recallContext";
import { parseSavedSearch, type SavedSearch } from "../components/recall/recallRetrieval";
/**
 * Links *into* Recall.
 *
 * Recall used to be reachable only from its own page, with its own device picker —
 * so every other timestamped view in the dashboard (the activity timeline, window
 * focus events, URL visits, rule events) could tell you when something happened but
 * not show you the screen. These helpers make "see this moment" a one-click action
 * from anywhere that has an agent and a timestamp.
 *
 * `at` is the same param the activity timeline already uses for its highlight, so a
 * single URL shape serves both tabs.
 */

/** Agent-detail URL opening the Recall tab on `iso`. */
export function agentRecallHref(agentId: string, iso?: string | null): string {
  const qs = new URLSearchParams({ tab: "recall" });
  if (iso) qs.set("at", iso);
  return `/agents/${agentId}?${qs.toString()}`;
}

/** Standalone Recall page URL, pre-selecting an agent and optionally a moment. */
export function recallPageHref(
  agentId: string,
  opts: { at?: string | null; day?: string | null; monitor?: number | null; search?: SavedSearch | null } = {},
): string {
  const qs = new URLSearchParams({ agent: agentId });
  if (opts.at) qs.set("at", opts.at);
  if (opts.day) qs.set("day", opts.day);
  if (opts.monitor != null) qs.set("monitor", String(opts.monitor));
  if (opts.search) writeRecallSearchParams(qs,opts.search);
  return `/recall?${qs.toString()}`;
}

/** Validate shared state before passing it into the player or date API. */
export function parseRecallParams(params: URLSearchParams) {
  const at = params.get("at");
  const day = params.get("day");
  const rawMonitor = params.get("monitor");
  return {
    agent: params.get("agent") || null,
    at: at && Number.isFinite(Date.parse(at)) ? at : null,
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day ? day : null,
    monitor: rawMonitor != null && /^\d+$/.test(rawMonitor) && Number.isSafeInteger(Number(rawMonitor))
      ? Number(rawMonitor) : null,
  };
}

/** Search state is additive: ordinary moment links keep their existing shape. */
const SEARCH_PARAMS = ["q","app","app_mode","title","url_host","context","search_scope","search_sort","search_from","search_to","search_monitor"] as const;
export function writeRecallSearchParams(params: URLSearchParams, search: SavedSearch | null): void {
  for (const name of SEARCH_PARAMS) params.delete(name);
  if (!search) return;
  const valid = parseSavedSearch(search);
  if (!valid) throw new Error("Invalid Recall search state");
  const filters = valid.filters!;
  params.set("q",valid.query); params.set("search_scope",valid.scope); params.set("search_sort",valid.sort);
  params.set("search_monitor",valid.monitor == null ? "all" : String(valid.monitor));
  if (valid.from) params.set("search_from",valid.from);
  if (valid.to) params.set("search_to",valid.to);
  if (filters.app) { params.set("app",filters.app); params.set("app_mode",filters.app_mode); }
  if (filters.title) params.set("title",filters.title);
  if (filters.url_host) params.set("url_host",filters.url_host);
  if (filters.context !== "all") params.set("context",filters.context);
}
export function parseRecallSearchParams(params: URLSearchParams): { search: SavedSearch | null; error: string | null } {
  if (!SEARCH_PARAMS.some(name=>params.has(name))) return {search:null,error:null};
  try {
    const filterValues: Record<string,string> = {};
    for (const name of ["app","app_mode","title","url_host","context"]) if (params.has(name)) filterValues[name]=params.get(name)!;
    const filters=parseRecallFilters(filterValues), query=params.get("q") ?? "";
    const rawMonitor=params.get("search_monitor") ?? params.get("monitor");
    if (rawMonitor !== null && rawMonitor !== "all" && !/^\d+$/.test(rawMonitor)) throw new Error("Invalid search monitor");
    const search=parseSavedSearch({query,scope:params.get("search_scope") ?? "retained",sort:params.get("search_sort") ?? (query.trim() ? "ranked" : "newest"),monitor:rawMonitor===null||rawMonitor==="all" ? null : Number(rawMonitor),from:params.get("search_from"),to:params.get("search_to"),filters});
    if (!search) throw new Error("Invalid saved search state");
    return {search,error:null};
  } catch { return {search:null,error:"The linked search filters are invalid or too long. Clear filters and start a new search."}; }
}
