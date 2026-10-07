import type { ApiClient } from "@/api";
import { isoHoursAgo, isoMinutesAgo } from "@/demo/data";

/** Fake URL categorisation endpoints. */
export function demoUrlCategoriesApi(): Partial<ApiClient> {
  return {
    urlCategorizationStatusGet: async () => ({
      settings: {
        enabled: true,
        auto_update: true,
        source_url: "https://demo.invalid/ut1.tar.gz",
        last_update_at: isoHoursAgo(18),
        last_update_error: null,
      },
      active_release: { sha256: "demo" },
      counts: { categories: 84, domains: 138_000, urls: 42_000 },
      job: null,
    }),
    urlCategorizationSettingsPut: async () => ({ ok: true }),
    urlCategorizationUpdateNow: async () => ({ ok: true }),
    urlCategorizationCategoriesGet: async () => ({
      categories: [
        { key: "productivity", label: "Productivity", enabled: true, description: "Work tools and docs" },
        { key: "social_networks", label: "Social networks", enabled: true, description: "Social media sites" },
        { key: "information", label: "Information", enabled: true, description: "News and reference sites" },
      ],
    }),
    urlCategorizationCategoriesPut: async (body) => ({
      categories: body.categories.map((c) => ({ ...c, label: c.label ?? c.key, description: c.description ?? "" })),
    }),
    urlCategorizationOverridesList: async () => ({
      rows: [
        {
          id: 1,
          kind: "domain",
          value: "github.com",
          category_key: "productivity",
          category_label: "Productivity",
          note: "Demo override",
          created_at: isoHoursAgo(5),
        },
      ],
    }),
    urlCategorizationOverridesUpsert: async () => ({ ok: true }),
    urlCategorizationOverridesDelete: async () => ({ ok: true }),
    urlCategorizationRecalcUrlVisits: async () => ({ enqueued: 500 }),
    urlCategorizationRecalcUrlSessions: async () => ({ updated: 200 }),
    agentUrlCategoryStats: async () => ({
      rows: [
        { category: "Productivity", visit_count: 42, last_ts: isoMinutesAgo(8) },
        { category: "Information", visit_count: 23, last_ts: isoMinutesAgo(19) },
        { category: "Social networks", visit_count: 4, last_ts: isoMinutesAgo(55) },
      ],
    }),
    agentUrlCategoryBackfill: async () => ({ enqueued: 250 }),
    urlCustomCategoriesList: async () => ({
      rows: [{ id: 1, key: "design_tools", label_en: "Design tools", description_en: "Design and product work", display_order: 10, hidden: false, updated_at: isoHoursAgo(30), member_count: 1, ut1_keys: ["productivity"] }],
    }),
    urlCustomCategoriesCreate: async () => ({ id: 2 }),
    urlCustomCategoriesUpdate: async () => ({ ok: true }),
    urlCustomCategoriesDelete: async () => ({ ok: true }),
    urlCustomCategoriesPutMembers: async () => ({ ok: true, count: 1 }),
  };
}
