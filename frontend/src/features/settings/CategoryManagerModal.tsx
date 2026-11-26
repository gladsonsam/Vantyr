/**
 * CategoryManagerModal
 *
 * One-stop shop for managing how UT1 categories appear in the UI:
 *   - Rename any UT1 category (persists across UT1 updates via url_category_labels)
 *   - Enable / disable a category entirely (hides from analytics + URL history)
 *   - Create custom "groups" (url_custom_categories) and put any UT1 categories into them
 *     so many-to-one rollup collapses them in analytics
 *
 * All changes are staged locally (see lib/categoryDraft) and saved in one "Save changes" click.
 */

import { useState, type Dispatch, type SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
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
import { errorText } from "@/api/client";
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
  type CategoryDraft,
  type ServerCategoryLists,
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Both lists load while the dialog is open (re-fetched on every open); each fresh pair re-seeds
  // the staged edits below, discarding unsaved changes like the old reload did.
  const categoriesQuery = useQuery({ ...urlCategoryQueries.categories(), enabled: visible });
  const groupsQuery = useQuery({ ...urlCategoryQueries.customCategories(), enabled: visible });
  const loading = categoriesQuery.isFetching || groupsQuery.isFetching;
  const hasLists = categoriesQuery.data !== undefined && groupsQuery.data !== undefined;
  const loadFailure = categoriesQuery.error ?? groupsQuery.error;
  const serverLists = loadedCategoryLists(categoriesQuery.data, groupsQuery.data, loading);
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

  const retryLoad = () => {
    void categoriesQuery.refetch();
    void groupsQuery.refetch();
  };

  const saveAll = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveCategoryDraft(draft);
      setSaved(true);
      // Refresh every view showing categories (analytics, URL history, category pickers),
      // including this dialog's own lists, which re-seeds the staged edits.
      await invalidateUrlCategoryViews(queryClient);
    } catch (e) {
      setError(
        `Not saved completely. ${errorText(e)} Some changes may already be applied; your edits are kept here.`,
      );
    } finally {
      setSaving(false);
    }
  };

  const { dirtyCount, groupChanges, hasChanges } = pendingChanges(draft);
  const pending = dirtyCount + groupChanges;
  const blankGroup = draft.groups.some((g) => !g.deleted && !g.label.trim());

  const discardEdits = () => setDraft(serverLists ? toDraft(serverLists) : EMPTY_DRAFT);
  const requestClose = () => {
    if (saving) return;
    if (hasChanges) setConfirmDiscard(true);
    else onDismiss();
  };

  return (
    <>
      <Dialog open={visible} onOpenChange={(open) => !open && requestClose()}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-[min(56rem,calc(100%-2rem))]">
          <DialogHeader>
            <DialogTitle>Manage categories</DialogTitle>
            <DialogDescription>
              Rename the categories from the lists, hide them from analytics, or roll several into
              one group. Changes survive list updates and apply when you save.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
            <EditorBody
              saveError={saveError}
              loadFailure={loadFailure}
              hasLists={hasLists}
              loading={loading}
              draft={draft}
              setDraft={setDraft}
              onRetry={retryLoad}
            />
          </div>

          <ManagerFooter
            saved={saved}
            hasChanges={hasChanges}
            pending={pending}
            blankGroup={blankGroup}
            saving={saving}
            onDiscard={discardEdits}
            onClose={requestClose}
            onSave={() => void saveAll()}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard {pending} unsaved {pending === 1 ? "change" : "changes"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Closing now drops the edits you haven't saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                discardEdits();
                setConfirmDiscard(false);
                onDismiss();
              }}
            >
              Discard and close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function EditorBody({
  saveError,
  loadFailure,
  hasLists,
  loading,
  draft,
  setDraft,
  onRetry,
}: {
  saveError: string | null;
  loadFailure: unknown;
  hasLists: boolean;
  loading: boolean;
  draft: CategoryDraft;
  setDraft: Dispatch<SetStateAction<CategoryDraft>>;
  onRetry: () => void;
}) {
  return (
    <>
      {saveError ? (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}
      {loadFailure ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {hasLists
                ? "Couldn't refresh the lists. What's shown may be out of date."
                : "Couldn't load the categories."}{" "}
              {errorText(loadFailure)}
            </span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {/* No editor without the real lists: an empty one could be saved over them. */}
      {!hasLists ? (
        loadFailure ? null : (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> Loading categories…
          </p>
        )
      ) : (
        <>
          <CustomGroupsPanel
            draft={draft}
            onAdd={(label) => setDraft((prev) => addGroup(prev, label))}
            onPatch={(index, patch) => setDraft((prev) => patchGroup(prev, index, patch))}
            onDelete={(index) => setDraft((prev) => removeGroup(prev, index))}
          />
          <Ut1CategoryTable
            draft={draft}
            loading={loading}
            onPatch={(key, patch) => setDraft((prev) => patchCategory(prev, key, patch))}
            onAssignGroup={(key, value) =>
              setDraft((prev) => assignCategoryGroup(prev, key, value))
            }
          />
        </>
      )}
    </>
  );
}

function ManagerFooter({
  saved,
  hasChanges,
  pending,
  blankGroup,
  saving,
  onDiscard,
  onClose,
  onSave,
}: {
  saved: boolean;
  hasChanges: boolean;
  pending: number;
  blankGroup: boolean;
  saving: boolean;
  onDiscard: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <DialogFooter className="items-center">
      {saved && !hasChanges ? (
        <span role="status" className="mr-auto text-sm text-success">
          Saved. Analytics and URL history now use these names.
        </span>
      ) : hasChanges ? (
        <span role="status" className="mr-auto text-sm text-muted-foreground">
          {blankGroup
            ? "Every group needs a name."
            : `${pending} unsaved ${pending === 1 ? "change" : "changes"}`}
        </span>
      ) : null}
      {hasChanges ? (
        <Button variant="outline" onClick={onDiscard} disabled={saving}>
          Discard changes
        </Button>
      ) : null}
      <Button variant="outline" onClick={onClose} disabled={saving}>
        Close
      </Button>
      <Button disabled={!hasChanges || saving || blankGroup} onClick={onSave}>
        {saving && <Spinner />} Save changes
      </Button>
    </DialogFooter>
  );
}

function loadedCategoryLists(
  categories: ServerCategoryLists["categories"] | undefined,
  groups: ServerCategoryLists["groups"] | undefined,
  loading: boolean,
): ServerCategoryLists | undefined {
  return categories && groups && !loading ? { categories, groups } : undefined;
}
