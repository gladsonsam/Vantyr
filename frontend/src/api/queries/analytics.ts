import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

/** Relative analytics window ending now. */
export type AnalyticsRange = "1h" | "24h" | "7d" | "30d";

/** Absolute `from`/`to` for `range`, resolved against the clock at request time so a refetch means "up to now". */
function rangeWindow(range: AnalyticsRange): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime());
  if (range === "1h") from.setHours(from.getHours() - 1);
  else if (range === "24h") from.setDate(from.getDate() - 1);
  else if (range === "7d") from.setDate(from.getDate() - 7);
  else from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

export const analyticsKeys = {
  agent: (id: string) => [...agentKeys.agent(id), "analytics"] as const,
  categories: (id: string, range: AnalyticsRange) => [...analyticsKeys.agent(id), "categories", range] as const,
  sites: (id: string, range: AnalyticsRange, customCategoryKey: string | null) =>
    [...analyticsKeys.agent(id), "sites", range, customCategoryKey] as const,
  sessions: (id: string, range: AnalyticsRange) => [...analyticsKeys.agent(id), "sessions", range] as const,
};

export const analyticsQueries = {
  categories: (id: string, range: AnalyticsRange) =>
    queryOptions({
      queryKey: analyticsKeys.categories(id, range),
      queryFn: () => api.agentAnalyticsUrlCategories(id, { ...rangeWindow(range), limit: 25 }),
    }),
  sites: (id: string, range: AnalyticsRange, customCategoryKey: string | null) =>
    queryOptions({
      queryKey: analyticsKeys.sites(id, range, customCategoryKey),
      queryFn: () =>
        api.agentAnalyticsUrlSites(id, { ...rangeWindow(range), limit: 25, custom_category_key: customCategoryKey ?? undefined }),
    }),
  sessions: (id: string, range: AnalyticsRange) =>
    queryOptions({
      queryKey: analyticsKeys.sessions(id, range),
      queryFn: () => api.agentAnalyticsUrlSessions(id, { ...rangeWindow(range), limit: 200 }),
    }),
};
