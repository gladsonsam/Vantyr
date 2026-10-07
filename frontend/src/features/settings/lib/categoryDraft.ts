/**
 * Staged edits behind the "Manage categories" dialog: UT1 category labels / enabled flags and
 * custom rollup groups. Everything here is pure; the dialog keeps the draft in state and
 * `saveCategoryDraft` turns `buildSavePlan` into API calls.
 */

export interface Ut1Cat {
  key: string;
  /** Current display label (possibly edited locally). */
  label: string;
  description: string;
  enabled: boolean;
  /** Custom group this UT1 key belongs to (null = ungrouped). */
  groupId: number | null;
  /** Has the user changed anything? */
  dirty: boolean;
}

export interface CustomGroup {
  /** Null until the group exists on the server. */
  id: number | null;
  key: string;
  label: string;
  hidden: boolean;
  isNew: boolean;
  deleted: boolean;
}

export interface CategoryDraft {
  ut1Cats: Ut1Cat[];
  groups: CustomGroup[];
}

export interface ServerCategoryLists {
  categories: { categories?: { key: string; label?: string | null; description?: string | null; enabled: boolean }[] };
  groups: { rows?: { id: number; key: string; label_en: string; hidden: boolean; ut1_keys?: string[] }[] };
}

export const EMPTY_DRAFT: CategoryDraft = { ut1Cats: [], groups: [] };

/** Select value meaning "not in any group". */
export const NO_GROUP = "__none__";

export function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The draft a freshly loaded pair of server lists starts from. */
export function toDraft({ categories: catRes, groups: grpRes }: ServerCategoryLists): CategoryDraft {
  const keyToGroup = new Map<string, number>();
  for (const g of grpRes.rows ?? []) {
    for (const k of g.ut1_keys ?? []) {
      keyToGroup.set(k, g.id);
    }
  }
  return {
    ut1Cats: (catRes.categories ?? []).map((c) => ({
      key: c.key,
      label: c.label?.trim() || humanize(c.key),
      description: c.description ?? "",
      enabled: c.enabled,
      groupId: keyToGroup.get(c.key) ?? null,
      dirty: false,
    })),
    groups: (grpRes.rows ?? []).map((g) => ({
      id: g.id,
      key: g.key,
      label: g.label_en,
      hidden: g.hidden,
      isNew: false,
      deleted: false,
    })),
  };
}

export function patchCategory(draft: CategoryDraft, key: string, patch: Partial<Ut1Cat>): CategoryDraft {
  return { ...draft, ut1Cats: draft.ut1Cats.map((c) => (c.key === key ? { ...c, ...patch, dirty: true } : c)) };
}

export function patchGroup(draft: CategoryDraft, index: number, patch: Partial<CustomGroup>): CategoryDraft {
  return { ...draft, groups: draft.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) };
}

/** "Fun & Games" -> "fun_games". */
export function slugifyGroupKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Adds a new group; an empty label (or one that slugs to nothing) leaves the draft unchanged. */
export function addGroup(draft: CategoryDraft, labelInput: string, keyInput = ""): CategoryDraft {
  const label = labelInput.trim();
  const key = keyInput.trim() || slugifyGroupKey(label);
  if (!label || !key) return draft;
  return { ...draft, groups: [...draft.groups, { id: null, key, label, hidden: false, isNew: true, deleted: false }] };
}

/**
 * Removes a group. A group that was never saved just disappears; a saved one is marked deleted and
 * its categories are unassigned.
 */
export function removeGroup(draft: CategoryDraft, index: number): CategoryDraft {
  const group = draft.groups[index];
  if (!group) return draft;
  if (group.isNew) return { ...draft, groups: draft.groups.filter((_, i) => i !== index) };
  return {
    groups: draft.groups.map((g, i) => (i === index ? { ...g, deleted: true } : g)),
    ut1Cats: group.id === null
      ? draft.ut1Cats
      : draft.ut1Cats.map((c) => (c.groupId === group.id ? { ...c, groupId: null, dirty: true } : c)),
  };
}

export function groupSelectOptions(groups: CustomGroup[]): { value: string; label: string }[] {
  const opts = groups
    .filter((g) => !g.deleted)
    .map((g) => ({ value: String(g.id ?? `new:${g.key}`), label: g.label }));
  return [{ value: NO_GROUP, label: "— No group —" }, ...opts];
}

/** The select value showing a category's group, falling back to "no group" for a deleted one. */
export function groupSelectValue(cat: Ut1Cat, options: { value: string }[]): string {
  const value = cat.groupId !== null ? String(cat.groupId) : NO_GROUP;
  return options.some((o) => o.value === value) ? value : NO_GROUP;
}

export function groupLabelById(groups: CustomGroup[], id: number | null): string {
  if (id === null) return "";
  const g = groups.find((x) => x.id === id && !x.deleted);
  return g ? g.label : "";
}

/**
 * Applies a group choice from the select. Groups that don't exist on the server yet have no id to
 * assign, so choosing one leaves the category as it was.
 */
export function assignCategoryGroup(draft: CategoryDraft, catKey: string, selectValue: string | null): CategoryDraft {
  if (selectValue === null || selectValue === NO_GROUP) return patchCategory(draft, catKey, { groupId: null });
  if (selectValue.startsWith("new:")) {
    const key = selectValue.slice("new:".length);
    const g = draft.groups.find((x) => x.isNew && x.key === key && !x.deleted);
    if (g?.id !== null && g?.id !== undefined) return patchCategory(draft, catKey, { groupId: g.id });
    return draft;
  }
  const numVal = Number(selectValue);
  if (Number.isNaN(numVal)) return draft;
  return patchCategory(draft, catKey, { groupId: numVal });
}

/** Categories matching the search text by key, label, description or group name. */
export function filterCategories(draft: CategoryDraft, text: string): Ut1Cat[] {
  const q = text.toLowerCase();
  if (!q) return draft.ut1Cats;
  return draft.ut1Cats.filter(
    (c) =>
      c.key.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      groupLabelById(draft.groups, c.groupId).toLowerCase().includes(q),
  );
}

export function pendingChanges(draft: CategoryDraft): { dirtyCount: number; groupChanges: number; hasChanges: boolean } {
  const dirtyCount = draft.ut1Cats.filter((c) => c.dirty).length;
  const groupChanges = draft.groups.filter((g) => g.isNew || g.deleted).length;
  return { dirtyCount, groupChanges, hasChanges: dirtyCount > 0 || groupChanges > 0 };
}

export type GroupOp =
  | { type: "create"; key: string; label_en: string; hidden: boolean }
  | { type: "update"; id: number; key: string; label_en: string; hidden: boolean };

export interface SavePlan {
  /** Every category's label / enabled flag / description, sent in one request. */
  categories: { key: string; enabled: boolean; label: string; description: string }[];
  /** Creates and updates of the groups that survive, in list order. */
  groupOps: GroupOp[];
  /** Server ids of groups to delete. */
  deleteIds: number[];
  /** For each surviving group, the UT1 keys it should contain. */
  members: { groupKey: string; ut1Keys: string[] }[];
}

/** What saving the draft has to send. Pure so the diff can be tested without the API. */
export function buildSavePlan(draft: CategoryDraft): SavePlan {
  const { ut1Cats, groups } = draft;
  const live = groups.filter((g) => !g.deleted);

  const groupOps: GroupOp[] = [];
  for (const g of live) {
    if (g.isNew) groupOps.push({ type: "create", key: g.key, label_en: g.label, hidden: g.hidden });
    else if (g.id !== null) groupOps.push({ type: "update", id: g.id, key: g.key, label_en: g.label, hidden: g.hidden });
  }

  const deleteIds: number[] = [];
  for (const g of groups) {
    if (g.deleted && g.id !== null) deleteIds.push(g.id);
  }

  const membersByKey = new Map<string, string[]>();
  for (const c of ut1Cats) {
    if (c.groupId === null) continue;
    const g = live.find((x) => x.id === c.groupId);
    if (!g) continue;
    membersByKey.set(g.key, [...(membersByKey.get(g.key) ?? []), c.key]);
  }

  return {
    categories: ut1Cats.map((c) => ({ key: c.key, enabled: c.enabled, label: c.label, description: c.description })),
    groupOps,
    deleteIds,
    members: live.map((g) => ({ groupKey: g.key, ut1Keys: membersByKey.get(g.key) ?? [] })),
  };
}
