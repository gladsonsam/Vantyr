import { describe, expect, it } from "vitest";
import {
  addGroup,
  assignCategoryGroup,
  buildSavePlan,
  filterCategories,
  groupSelectOptions,
  groupSelectValue,
  humanize,
  NO_GROUP,
  patchCategory,
  patchGroup,
  pendingChanges,
  removeGroup,
  slugifyGroupKey,
  toDraft,
  type CategoryDraft,
} from "@/features/settings/lib/categoryDraft";

const server = {
  categories: {
    categories: [
      { key: "social_networks", label: "", description: null, enabled: true },
      { key: "games", label: " Gaming ", description: "Play", enabled: false },
      { key: "news", label: "News", description: "", enabled: true },
    ],
  },
  groups: { rows: [{ id: 7, key: "fun", label_en: "Fun", hidden: false, ut1_keys: ["games", "social_networks"] }] },
};

describe("toDraft", () => {
  it("humanizes blank labels, trims labels and links categories to their group", () => {
    const draft = toDraft(server);
    expect(draft.ut1Cats.map((c) => [c.key, c.label, c.groupId, c.dirty])).toEqual([
      ["social_networks", "Social Networks", 7, false],
      ["games", "Gaming", 7, false],
      ["news", "News", null, false],
    ]);
    expect(draft.groups).toEqual([{ id: 7, key: "fun", label: "Fun", hidden: false, isNew: false, deleted: false }]);
  });

  it("copes with missing lists", () => {
    expect(toDraft({ categories: {}, groups: {} })).toEqual({ ut1Cats: [], groups: [] });
  });
});

describe("humanize / slugifyGroupKey", () => {
  it("turns keys into title case and labels into keys", () => {
    expect(humanize("adult-content_sites")).toBe("Adult Content Sites");
    expect(slugifyGroupKey("  Fun & Games! ")).toBe("fun_games");
  });
});

describe("editing", () => {
  const draft = toDraft(server);

  it("marks a patched category dirty without touching the others", () => {
    const next = patchCategory(draft, "news", { enabled: false });
    expect(next.ut1Cats.find((c) => c.key === "news")).toMatchObject({ enabled: false, dirty: true });
    expect(next.ut1Cats.filter((c) => c.dirty)).toHaveLength(1);
    expect(draft.ut1Cats.every((c) => !c.dirty)).toBe(true);
  });

  it("patches a group by index", () => {
    expect(patchGroup(draft, 0, { hidden: true }).groups[0].hidden).toBe(true);
  });

  it("adds a new group keyed from its label, ignoring blank labels", () => {
    const next = addGroup(draft, " Study ");
    expect(next.groups[1]).toEqual({ id: null, key: "study", label: "Study", hidden: false, isNew: true, deleted: false });
    expect(addGroup(draft, "   ")).toBe(draft);
    expect(addGroup(draft, "!!!")).toBe(draft);
    expect(addGroup(draft, "Study", " custom_key ").groups[1].key).toBe("custom_key");
  });

  it("drops an unsaved group outright", () => {
    const withNew = addGroup(draft, "Study");
    expect(removeGroup(withNew, 1).groups).toHaveLength(1);
  });

  it("marks a saved group deleted and unassigns its categories", () => {
    const next = removeGroup(draft, 0);
    expect(next.groups[0].deleted).toBe(true);
    expect(next.ut1Cats.filter((c) => c.groupId === null && c.dirty).map((c) => c.key)).toEqual(["social_networks", "games"]);
  });

  it("assigns and clears a category's group from the select value", () => {
    expect(assignCategoryGroup(draft, "news", "7").ut1Cats[2].groupId).toBe(7);
    expect(assignCategoryGroup(draft, "games", NO_GROUP).ut1Cats[1].groupId).toBeNull();
    expect(assignCategoryGroup(draft, "news", "nope")).toBe(draft);
  });

  it("cannot assign to a group that has no server id yet", () => {
    const withNew = addGroup(draft, "Study");
    expect(assignCategoryGroup(withNew, "news", "new:study")).toBe(withNew);
  });
});

describe("selectors", () => {
  const draft = toDraft(server);

  it("lists live groups after the no-group option", () => {
    const withNew = addGroup(removeGroup(addGroup(draft, "Gone"), 1), "Study");
    expect(groupSelectOptions(withNew.groups)).toEqual([
      { value: NO_GROUP, label: "— No group —" },
      { value: "7", label: "Fun" },
      { value: "new:study", label: "Study" },
    ]);
  });

  it("shows no group for a category whose group was deleted", () => {
    const deleted: CategoryDraft = { ...draft, groups: patchGroup(draft, 0, { deleted: true }).groups };
    expect(groupSelectValue(draft.ut1Cats[0], groupSelectOptions(draft.groups))).toBe("7");
    expect(groupSelectValue(draft.ut1Cats[0], groupSelectOptions(deleted.groups))).toBe(NO_GROUP);
  });

  it("filters by key, label, description and group name", () => {
    expect(filterCategories(draft, "").length).toBe(3);
    expect(filterCategories(draft, "SOCIAL").map((c) => c.key)).toEqual(["social_networks"]);
    expect(filterCategories(draft, "play").map((c) => c.key)).toEqual(["games"]);
    expect(filterCategories(draft, "fun").map((c) => c.key)).toEqual(["social_networks", "games"]);
    expect(filterCategories(draft, "zzz")).toEqual([]);
  });

  it("counts dirty categories and new or deleted groups", () => {
    expect(pendingChanges(draft)).toEqual({ dirtyCount: 0, groupChanges: 0, hasChanges: false });
    const edited = addGroup(patchCategory(draft, "news", { label: "X" }), "Study");
    expect(pendingChanges(edited)).toEqual({ dirtyCount: 1, groupChanges: 1, hasChanges: true });
  });
});

describe("buildSavePlan", () => {
  it("sends every category, updates saved groups, creates new ones and lists members", () => {
    let draft = toDraft(server);
    draft = patchGroup(draft, 0, { label: "Fun!" });
    draft = addGroup(draft, "Study");
    const plan = buildSavePlan(draft);
    expect(plan.categories).toHaveLength(3);
    expect(plan.categories[1]).toEqual({ key: "games", enabled: false, label: "Gaming", description: "Play" });
    expect(plan.groupOps).toEqual([
      { type: "update", id: 7, key: "fun", label_en: "Fun!", hidden: false },
      { type: "create", key: "study", label_en: "Study", hidden: false },
    ]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.members).toEqual([
      { groupKey: "fun", ut1Keys: ["social_networks", "games"] },
      { groupKey: "study", ut1Keys: [] },
    ]);
  });

  it("deletes removed groups and does not send them members", () => {
    const plan = buildSavePlan(removeGroup(toDraft(server), 0));
    expect(plan.deleteIds).toEqual([7]);
    expect(plan.groupOps).toEqual([]);
    expect(plan.members).toEqual([]);
  });
});
