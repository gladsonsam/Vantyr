/**
 * CategoryManagerModal
 *
 * One-stop shop for managing how UT1 categories appear in the UI:
 *   - Rename any UT1 category (persists across UT1 updates via url_category_labels)
 *   - Enable / disable a category entirely (hides from analytics + URL history)
 *   - Create custom "groups" (url_custom_categories) and put any UT1 categories into them
 *     so many-to-one rollup collapses them in analytics
 *
 * All changes are staged locally (see lib/categoryDraft) and saved in one "Save all" click.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import { invalidateUrlCategoryViews, urlCategoryQueries } from "@/api/queries/urlCategories";
import { useServerDraft } from "@/hooks/useServerDraft";
import { CustomGroupsPanel } from "./components/CustomGroupsPanel";
import { Ut1CategoryTable } from "./components/Ut1CategoryTable";
import {
  addGroup,
  assignCategoryGroup,
  EMPTY_DRAFT,
  patchCategory,
  patchGroup,
  pendingChanges,
  removeGroup,
  toDraft,
} from "./lib/categoryDraft";
import { saveCategoryDraft } from "./lib/saveCategoryDraft";

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

export function CategoryManagerModal({ visible, onDismiss }: Props) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saveError, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Both lists load while the dialog is open (re-fetched on every open); each fresh pair re-seeds
  // the staged edits below, discarding unsaved changes like the old reload did.
  const categoriesQuery = useQuery({ ...urlCategoryQueries.categories(), enabled: visible });
  const groupsQuery = useQuery({ ...urlCategoryQueries.customCategories(), enabled: visible });
  const loading = categoriesQuery.isFetching || groupsQuery.isFetching;
  const loadFailure = categoriesQuery.error ?? groupsQuery.error;
  const error = saveError ?? (loadFailure ? String(loadFailure) : null);
  const serverLists =
    categoriesQuery.data && groupsQuery.data && !categoriesQuery.isFetching && !groupsQuery.isFetching
      ? { categories: categoriesQuery.data, groups: groupsQuery.data }
      : undefined;
  const [draft, setDraft] = useServerDraft(
    serverLists,
    Math.max(categoriesQuery.dataUpdatedAt, groupsQuery.dataUpdatedAt),
    toDraft,
    EMPTY_DRAFT,
  );

  // A fresh open clears the previous save feedback, like the old reload did.
  const [prevVisible, setPrevVisible] = useState(visible);
  if (prevVisible !== visible) {
    setPrevVisible(visible);
    if (visible) {
      setSaved(false);
      setError(null);
    }
  }

  const saveAll = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveCategoryDraft(draft);
      setSaved(true);
      // Refresh every view showing categories (analytics, URL history, category pickers),
      // including this dialog's own lists, which re-seeds the staged edits.
      await invalidateUrlCategoryViews(queryClient);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const { dirtyCount, groupChanges, hasChanges } = pendingChanges(draft);

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !saving && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Manage categories</DialogTitle>
          <DialogDescription>
            Rename categories, enable/disable them, or group multiple UT1 categories into a single display bucket. Changes survive UT1 list updates.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <CustomGroupsPanel
            groups={draft.groups}
            ut1Cats={draft.ut1Cats}
            onAdd={(label) => setDraft((prev) => addGroup(prev, label))}
            onPatch={(index, patch) => setDraft((prev) => patchGroup(prev, index, patch))}
            onDelete={(index) => setDraft((prev) => removeGroup(prev, index))}
          />

          <Ut1CategoryTable
            draft={draft}
            loading={loading}
            onPatch={(key, patch) => setDraft((prev) => patchCategory(prev, key, patch))}
            onAssignGroup={(key, value) => setDraft((prev) => assignCategoryGroup(prev, key, value))}
          />
        </div>

        <DialogFooter>
          {saved && !hasChanges ? (
            <span className="mr-auto text-sm text-success">Saved.</span>
          ) : null}
          <Button variant="outline" onClick={onDismiss} disabled={saving}>
            Close
          </Button>
          <Button disabled={!hasChanges || saving} onClick={() => void saveAll()}>
            {saving && <Spinner />} Save all changes{hasChanges ? ` (${dirtyCount + groupChanges} pending)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
