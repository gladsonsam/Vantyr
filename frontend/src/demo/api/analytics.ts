import type { ApiClient } from "@/api";
import { demoUrls, isoMinutesAgo } from "@/demo/data";

/** Fake URL analytics endpoints. */
export function demoAnalyticsApi(): Partial<ApiClient> {
  return {
    agentAnalyticsUrlCategories: async () => ({
      rows: [
        { category_key: "productivity", category_label: "Productivity", time_ms: 7_200_000, visit_count: 34, last_ts: isoMinutesAgo(4) },
        { category_key: "information", category_label: "Information", time_ms: 2_100_000, visit_count: 13, last_ts: isoMinutesAgo(11) },
      ],
    }),
    agentAnalyticsUrlSites: async () => ({
      rows: [
        { hostname: "github.com", category_key: "productivity", category_label: "Productivity", time_ms: 4_200_000, visit_count: 18, last_ts: isoMinutesAgo(4) },
        { hostname: "cloudscape.design", category_key: "productivity", category_label: "Productivity", time_ms: 1_800_000, visit_count: 9, last_ts: isoMinutesAgo(19) },
      ],
    }),
    agentAnalyticsUrlSessions: async (id) => ({
      rows: demoUrls(String(id), 20).map((u, index) => ({
        id: index + 1,
        url: u.url,
        hostname: new URL(u.url).hostname,
        ts_start: u.ts,
        ts_end: isoMinutesAgo(index * 13),
        duration_ms: 180_000 + index * 30_000,
        user: u.user,
        category_key: u.category_key,
        category_label: u.category,
        browser: u.browser,
        title: u.title,
      })),
    }),
  };
}
