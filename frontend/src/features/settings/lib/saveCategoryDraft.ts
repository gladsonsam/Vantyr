import { api } from "@/api";
import { buildSavePlan, type CategoryDraft } from "./categoryDraft";

/** Sends a staged category draft to the server, in the order the server needs it. */
export async function saveCategoryDraft(draft: CategoryDraft): Promise<void> {
  const plan = buildSavePlan(draft);

  // 1. UT1 category labels and enabled flags (every row, to be safe).
  await api.urlCategorizationCategoriesPut({ categories: plan.categories });

  // 2. Create / update the surviving groups, remembering the real id of each.
  const groupIds = new Map<string, number>();
  for (const op of plan.groupOps) {
    if (op.type === "create") {
      const res = await api.urlCustomCategoriesCreate({ key: op.key, label_en: op.label_en, hidden: op.hidden });
      groupIds.set(op.key, res.id);
    } else {
      await api.urlCustomCategoriesUpdate(op.id, { label_en: op.label_en, hidden: op.hidden });
      groupIds.set(op.key, op.id);
    }
  }

  // 3. Delete removed groups; one that is already gone is not an error.
  for (const id of plan.deleteIds) {
    await api.urlCustomCategoriesDelete(id).catch(() => {});
  }

  // 4. Set the members of every surviving group.
  for (const { groupKey, ut1Keys } of plan.members) {
    const id = groupIds.get(groupKey);
    if (!id) continue;
    await api.urlCustomCategoriesPutMembers(id, { ut1_keys: ut1Keys });
  }
}
