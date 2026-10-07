import { z } from "zod";
import type { CategoryOption, CustomGroup } from "./analytics";

/** What a category override applies to: a whole domain or a URL prefix. */
export interface AssignTarget {
  kind: "domain" | "url";
  value: string;
  hostname: string;
  url?: string | null;
}

/**
 * The assign-category form. `customKey` picks a custom category; `categoryKey` is the underlying
 * UT1 key the override is stored under (filled in from the custom category, or chosen when
 * `specific`). Saving needs a `categoryKey`.
 */
export const assignCategorySchema = z.object({
  customKey: z.string(),
  specific: z.boolean(),
  categoryKey: z.string().min(1),
  note: z.string(),
});
export type AssignCategoryValues = z.infer<typeof assignCategorySchema>;

export const ASSIGN_CATEGORY_DEFAULTS: AssignCategoryValues = { customKey: "", specific: false, categoryKey: "", note: "" };

export interface OverrideBody {
  kind: "domain" | "url";
  value: string;
  category_key: string;
  note?: string;
}

export function toOverrideBody(target: AssignTarget, values: AssignCategoryValues): OverrideBody {
  return {
    kind: target.kind,
    value: target.value,
    category_key: values.categoryKey,
    note: values.note.trim() ? values.note.trim() : undefined,
  };
}

/** The UT1 key a custom category starts from (its first); "" for none, so the override has no category yet. */
export function defaultCategoryKey(customKey: string, groups: CustomGroup[]): string {
  if (!customKey) return "";
  return groups.find((g) => g.key === customKey)?.ut1_keys?.[0] ?? "";
}

/** UT1 options for the "more specific" select: only those inside the chosen custom category. */
export function specificCategoryOptions(customKey: string, groups: CustomGroup[], options: CategoryOption[]): CategoryOption[] {
  if (!customKey) return options;
  const group = groups.find((g) => g.key === customKey);
  if (!group) return options;
  const allowed = new Set((group.ut1_keys ?? []).map((k) => String(k)));
  return options.filter((o) => allowed.has(o.value));
}
