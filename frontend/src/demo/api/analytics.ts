import type { ApiClient } from "@/api";
import { demoUrls, isoMinutesAgo } from "@/demo/data";

/** Fake URL analytics endpoints. */
export function demoAnalyticsApi(): Partial<ApiClient> {
  return {
    agentAnalyticsUrlCategories: async () => ({
      rows: [
        {
          category_key: "productivity",
          category_label: "Productivity",
          time_ms: 7_200_000,
          visit_count: 34,
          last_ts: isoMinutesAgo(4),
        },
        {
          category_key: "information",
          category_label: "Information",
          time_ms: 2_100_000,
          visit_count: 13,
          last_ts: isoMinutesAgo(11),
        },
        {
          category_key: "social_networks",
          category_label: "Social networks",
          time_ms: 1_320_000,
          visit_count: 21,
          last_ts: isoMinutesAgo(52),
        },
        {
          category_key: "video",
          category_label: "Video",
          time_ms: 900_000,
          visit_count: 6,
          last_ts: isoMinutesAgo(140),
        },
        {
          category_key: "shopping",
          category_label: "Shopping",
          time_ms: 420_000,
          visit_count: 5,
          last_ts: isoMinutesAgo(380),
        },
        {
          category_key: "news",
          category_label: "News",
          time_ms: 240_000,
          visit_count: 4,
          last_ts: isoMinutesAgo(600),
        },
        {
          category_key: "",
          category_label: "Uncategorized",
          time_ms: 60_000,
          visit_count: 2,
          last_ts: isoMinutesAgo(900),
        },
      ],
    }),
    agentAnalyticsUrlSites: async (_id, params) => {
      const rows = [
        {
          hostname: "github.com",
          category_key: "productivity",
          category_label: "Productivity",
          time_ms: 4_200_000,
          visit_count: 18,
          last_ts: isoMinutesAgo(4),
        },
        {
          hostname: "cloudscape.design",
          category_key: "productivity",
          category_label: "Productivity",
          time_ms: 1_800_000,
          visit_count: 9,
          last_ts: isoMinutesAgo(19),
        },
        {
          hostname: "docs.rs",
          category_key: "productivity",
          category_label: "Productivity",
          time_ms: 1_200_000,
          visit_count: 7,
          last_ts: isoMinutesAgo(33),
        },
        {
          hostname: "news.ycombinator.com",
          category_key: "information",
          category_label: "Information",
          time_ms: 1_320_000,
          visit_count: 8,
          last_ts: isoMinutesAgo(11),
        },
        {
          hostname: "en.wikipedia.org",
          category_key: "information",
          category_label: "Information",
          time_ms: 780_000,
          visit_count: 5,
          last_ts: isoMinutesAgo(75),
        },
        {
          hostname: "www.reddit.com",
          category_key: "social_networks",
          category_label: "Social networks",
          time_ms: 1_320_000,
          visit_count: 21,
          last_ts: isoMinutesAgo(52),
        },
        {
          hostname: "www.youtube.com",
          category_key: "video",
          category_label: "Video",
          time_ms: 900_000,
          visit_count: 6,
          last_ts: isoMinutesAgo(140),
        },
        {
          hostname: "reimbursement.24sevenplanmanagement.com.au",
          category_key: "shopping",
          category_label: "Shopping",
          time_ms: 420_000,
          visit_count: 5,
          last_ts: isoMinutesAgo(380),
        },
        {
          hostname: "example-unknown.test",
          category_key: "",
          category_label: "Uncategorized",
          time_ms: 60_000,
          visit_count: 2,
          last_ts: isoMinutesAgo(900),
        },
      ].sort((a, b) => b.time_ms - a.time_ms);
      return {
        rows: params?.custom_category_key
          ? rows.filter((r) => r.category_key === params.custom_category_key)
          : rows,
      };
    },
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
