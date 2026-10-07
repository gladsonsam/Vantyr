import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

export const urlCategoryKeys = {
  all: ["url-categories"] as const,
  categories: () => [...urlCategoryKeys.all, "categories"] as const,
  customCategories: () => [...urlCategoryKeys.all, "custom-categories"] as const,
};

export const urlCategoryQueries = {
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
