import { get, putJson, postEmpty, postJsonRes, delJson } from "@/api/client";

export const urlCategoriesEndpoints = {
  // ── URL categorization (UT1) ───────────────────────────────────────────────

  urlCategorizationStatusGet: (): Promise<{
    settings: {
      enabled: boolean;
      auto_update: boolean;
      source_url: string;
      last_update_at: string | null;
      last_update_error: string | null;
    };
    active_release: { sha256: string | null };
    counts: { categories: number; domains: number; urls: number };
    job?: {
      state: "idle" | "downloading" | "importing" | "ready" | "error";
      started_at: string | null;
      updated_at: string;
      bytes_total: number | null;
      bytes_done: number;
      message: string | null;
    } | null;
  }> => get("/settings/url-categorization"),

  urlCategorizationSettingsPut: (body: {
    enabled: boolean;
    auto_update: boolean;
    source_url: string;
  }): Promise<unknown> => putJson("/settings/url-categorization", body),

  urlCategorizationUpdateNow: (): Promise<unknown> =>
    postEmpty("/settings/url-categorization/update-now"),

  urlCategorizationCategoriesGet: (): Promise<{
    categories: { key: string; label?: string; enabled: boolean; description: string }[];
  }> => get("/settings/url-categorization/categories"),

  urlCategorizationCategoriesPut: (body: {
    categories: { key: string; enabled: boolean; label?: string; description?: string }[];
  }): Promise<{ categories: { key: string; label: string; enabled: boolean; description: string }[] }> =>
    putJson("/settings/url-categorization/categories", body),

  urlCategorizationOverridesList: (
    { q = "", limit = 200, offset = 0 }: { q?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: { id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string }[] }> =>
    get(`/settings/url-categorization/overrides?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),

  urlCategorizationOverridesUpsert: (body: { kind: "domain" | "url"; value: string; category_key: string; note?: string }): Promise<unknown> =>
    postJsonRes("/settings/url-categorization/overrides", body),

  urlCategorizationOverridesDelete: (kind: "domain" | "url", id: number): Promise<unknown> =>
    delJson(`/settings/url-categorization/overrides?kind=${encodeURIComponent(kind)}&id=${id}`),

  urlCategorizationRecalcUrlVisits: ({ limit = 50_000 }: { limit?: number } = {}): Promise<{ enqueued: number }> =>
    postEmpty(`/settings/url-categorization/recalc/url-visits?limit=${limit}`),

  urlCategorizationRecalcUrlSessions: ({ limit = 50_000 }: { limit?: number } = {}): Promise<{ updated: number }> =>
    postEmpty(`/settings/url-categorization/recalc/url-sessions?limit=${limit}`),

  agentUrlCategoryStats: (
    id: string,
    { limit = 24 }: { limit?: number } = {},
  ): Promise<{ rows: { category: string; visit_count: number; last_ts: string }[] }> =>
    get(`/agents/${id}/url-category-stats?limit=${limit}`),

  agentUrlCategoryBackfill: (
    id: string,
    { limit = 25_000 }: { limit?: number } = {},
  ): Promise<{ enqueued: number }> =>
    postEmpty(`/agents/${id}/url-category-backfill?limit=${limit}`),

  // ── Custom categories (admin rollups on top of UT1) ───────────────────────

  urlCustomCategoriesList: (): Promise<{
    rows: {
      id: number;
      key: string;
      label_en: string;
      description_en: string;
      display_order: number;
      hidden: boolean;
      updated_at: string;
      member_count: number;
      ut1_keys: string[];
    }[];
  }> => get("/settings/url-categorization/custom-categories"),

  urlCustomCategoriesCreate: (body: {
    key: string;
    label_en: string;
    description_en?: string;
    display_order?: number;
    hidden?: boolean;
  }): Promise<{ id: number }> => postJsonRes("/settings/url-categorization/custom-categories", body),

  urlCustomCategoriesUpdate: (
    id: number,
    body: { label_en?: string; description_en?: string; display_order?: number; hidden?: boolean },
  ): Promise<{ ok: boolean }> => putJson(`/settings/url-categorization/custom-categories/${id}`, body),

  urlCustomCategoriesDelete: (id: number): Promise<{ ok: boolean }> =>
    delJson(`/settings/url-categorization/custom-categories/${id}`),

  urlCustomCategoriesPutMembers: (
    id: number,
    body: { ut1_keys: string[] },
  ): Promise<{ ok: boolean; count: number }> =>
    putJson(`/settings/url-categorization/custom-categories/${id}/members`, body),
};
