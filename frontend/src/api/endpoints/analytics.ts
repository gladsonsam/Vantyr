import { get } from "@/api/client";

export const analyticsEndpoints = {
  // ── Agent analytics (URL sessions) ───────────────────────────────────────

  agentAnalyticsUrlCategories: (
    id: string,
    { from, to, limit = 50 }: { from: string; to: string; limit?: number },
  ): Promise<{ rows: { category_key: string; category_label: string; time_ms: number; visit_count: number; last_ts: string }[] }> =>
    get(`/agents/${id}/analytics/url-categories?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`),

  agentAnalyticsUrlSites: (
    id: string,
    {
      from,
      to,
      limit = 50,
      custom_category_key,
      category_key,
    }: { from: string; to: string; limit?: number; custom_category_key?: string; category_key?: string },
  ): Promise<{ rows: { hostname: string; category_key: string | null; category_label: string | null; time_ms: number; visit_count: number; last_ts: string }[] }> => {
    const custom = custom_category_key ? `&custom_category_key=${encodeURIComponent(custom_category_key)}` : "";
    const ut1 = category_key ? `&category_key=${encodeURIComponent(category_key)}` : "";
    return get(`/agents/${id}/analytics/url-sites?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}${custom}${ut1}`);
  },

  agentAnalyticsUrlSessions: (
    id: string,
    { from, to, limit = 200 }: { from: string; to: string; limit?: number },
  ): Promise<{ rows: { id: number; url: string; hostname: string; ts_start: string; ts_end: string; duration_ms: number; user?: string | null; category_key?: string | null; category_label?: string | null; browser?: string | null; title?: string | null }[] }> =>
    get(`/agents/${id}/analytics/url-sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`),
};
