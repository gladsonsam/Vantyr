import { queryOptions, useMutation, type QueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const urlCategoryKeys = {
  all: ["url-categories"] as const,
  categories: () => [...urlCategoryKeys.all, "categories"] as const,
  customCategories: () => [...urlCategoryKeys.all, "custom-categories"] as const,
  /** UT1 list download/import status and settings. */
  status: () => [...urlCategoryKeys.all, "status"] as const,
  overrides: (q: string) => [...urlCategoryKeys.all, "overrides", q] as const,
};

export const urlCategoryQueries = {
  status: () =>
    queryOptions({
      queryKey: urlCategoryKeys.status(),
      queryFn: () => api.urlCategorizationStatusGet(),
    }),
  /** Admin domain/URL overrides matching `q` (first 500). */
  overrides: (q: string) =>
    queryOptions({
      queryKey: urlCategoryKeys.overrides(q),
      queryFn: () => api.urlCategorizationOverridesList({ q, limit: 500, offset: 0 }),
    }),
  /** UT1 categories with their display labels and enabled flags. */
  categories: () =>
    queryOptions({
      queryKey: urlCategoryKeys.categories(),
      queryFn: () => api.urlCategorizationCategoriesGet(),
    }),
  /** Admin rollup groups on top of UT1. */
  customCategories: () =>
    queryOptions({
      queryKey: urlCategoryKeys.customCategories(),
      queryFn: () => api.urlCustomCategoriesList(),
    }),
};

/**
 * Category labels, groups or overrides changed: refresh the category lists and every per-agent view
 * that shows categorized URLs (URL history and browsing analytics).
 */
export function invalidateUrlCategoryViews(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: urlCategoryKeys.all }),
    queryClient.invalidateQueries({
      queryKey: agentKeys.all,
      predicate: (query) => query.queryKey[2] === "urls" || query.queryKey[2] === "analytics",
    }),
  ]).then(() => undefined);
}

/** Add or update one domain / URL-prefix category override. */
export function useUpsertUrlOverrideMutation() {
  return useMutation({
    mutationFn: (body: Parameters<typeof api.urlCategorizationOverridesUpsert>[0]) => api.urlCategorizationOverridesUpsert(body),
  });
}

export function useDeleteUrlOverrideMutation() {
  return useMutation({
    mutationFn: ({ kind, id }: { kind: "domain" | "url"; id: number }) => api.urlCategorizationOverridesDelete(kind, id),
  });
}

/** Re-run categorization over recent URL visits. */
export function useRecalcUrlVisitsMutation() {
  return useMutation({ mutationFn: () => api.urlCategorizationRecalcUrlVisits({ limit: 100_000 }) });
}

/** Re-run categorization over recent URL sessions. */
export function useRecalcUrlSessionsMutation() {
  return useMutation({ mutationFn: () => api.urlCategorizationRecalcUrlSessions({ limit: 100_000 }) });
}
