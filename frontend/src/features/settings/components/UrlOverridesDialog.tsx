import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { errorText } from "@/api/client";
import {
  urlCategoryKeys,
  urlCategoryQueries,
  useDeleteUrlOverrideMutation,
  useUpsertUrlOverrideMutation,
} from "@/api/queries/urlCategories";
import { InputField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import { humanize } from "../lib/categoryDraft";
import { urlOverrideSchema, type UrlOverrideValues } from "../lib/urlCategorizationSchemas";
import { UrlOverrideList, type UrlOverrideRow } from "./UrlOverrideList";
import { UrlRecalcActions } from "./UrlRecalcActions";

const NO_OVERRIDES: UrlOverrideRow[] = [];
const NO_CATEGORIES: { key: string; label?: string; enabled: boolean; description: string }[] = [];

/** Manage the admin domain / URL-prefix category overrides. */
export function UrlOverridesDialog({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusNotice, setFocusNotice] = useState(0);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [search, setSearch] = useState("");
  const form = useForm<UrlOverrideValues>({
    resolver: zodResolver(urlOverrideSchema),
    mode: "onChange",
    defaultValues: { kind: "domain", value: "", category_key: "", note: "" },
  });
  const { control } = form;
  const { isValid, isSubmitting } = form.formState;
  const addKind = useWatch({ control, name: "kind" });

  const upsert = useUpsertUrlOverrideMutation();
  const deleteOverride = useDeleteUrlOverrideMutation();

  // Loaded while the dialog is open; typing in the search box re-keys the list (keeping the
  // previous rows up until the new ones arrive).
  const overridesQuery = useQuery({
    ...urlCategoryQueries.overrides(search),
    enabled: open && isAdmin,
    placeholderData: keepPreviousData,
  });
  const rows = overridesQuery.data?.rows ?? NO_OVERRIDES;
  const fetchOverrides = async () => {
    await queryClient.invalidateQueries({ queryKey: urlCategoryKeys.overrides(search) });
  };

  // After a removal the row (and its focus) is gone, so the confirmation message takes focus.
  useEffect(() => {
    if (focusNotice > 0) noticeRef.current?.focus();
  }, [focusNotice]);

  const addOverride = form.handleSubmit(async (values) => {
    setActionError(null);
    setNotice(null);
    try {
      await upsert.mutateAsync({ kind: values.kind, value: values.value, category_key: values.category_key, note: values.note });
      setNotice(`Saved the override for ${values.value}.`);
      form.setValue("value", "", { shouldValidate: true });
      form.setValue("note", "");
      await fetchOverrides();
    } catch (e) {
      setActionError(`Not saved. ${errorText(e)}`);
    }
  });

  const categoriesQuery = useQuery({ ...urlCategoryQueries.categories(), enabled: open && isAdmin });
  const categories = categoriesQuery.data?.categories ?? NO_CATEGORIES;
  const choices = categories.filter((c) => c.enabled);

  const deleteRow = async (row: UrlOverrideRow) => {
    setActionError(null);
    setNotice(null);
    try {
      await deleteOverride.mutateAsync({ kind: row.kind, id: row.id });
      setNotice(`Removed the override for ${row.value}.`);
      setFocusNotice((n) => n + 1);
      await fetchOverrides();
    } catch (e) {
      setActionError(`Not removed. ${errorText(e)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-[min(42rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>URL category overrides</DialogTitle>
          <DialogDescription>
            An override pins a domain, or every URL starting with a prefix, to a category. Overrides win over the downloaded lists and survive list updates.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={addOverride} noValidate className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField control={control} name="kind" id="override-kind" label="Match" description="A domain override covers the whole host. A URL prefix covers only addresses that start with it.">
                {({ field, id }) => (
                  <Select value={field.value} onValueChange={(value) => value && field.onChange(value as "domain" | "url")}>
                    <SelectTrigger id={id} className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="domain">Domain</SelectItem>
                      <SelectItem value="url">URL prefix</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField control={control} name="category_key" id="override-category" label="Category" hideError>
                {({ field, id }) => (
                  <Select value={field.value} onValueChange={(value) => field.onChange(value ?? "")} disabled={choices.length === 0}>
                    <SelectTrigger id={id} className="h-9 w-full">
                      <SelectValue placeholder={categoriesQuery.isPending ? "Loading…" : "Choose a category"} />
                    </SelectTrigger>
                    <SelectContent>
                      {choices.map((c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {(c.label ?? "").trim() || humanize(c.key) || c.key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>
            <CategoryChoiceNotice
              failed={categoriesQuery.isError}
              empty={!categoriesQuery.isPending && !categoriesQuery.isError && choices.length === 0}
              onRetry={() => void categoriesQuery.refetch()}
            />

            <InputField
              control={control}
              name="value"
              id="override-value"
              label={addKind === "domain" ? "Domain" : "URL prefix"}
              placeholder={addKind === "domain" ? "example.com" : "https://example.com/path"}
              className="h-9"
              inputMode={addKind === "domain" ? "text" : "url"}
              autoComplete="off"
              spellCheck={false}
              hideError
            />
            <InputField control={control} name="note" id="override-note" label="Note (optional)" className="h-9" />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={isSubmitting || !isValid}>
                {isSubmitting && <Spinner />} Save override
              </Button>
              <span className="text-sm text-muted-foreground">Saving a value that already has an override changes its category.</span>
            </div>
            {notice ? (
              <p ref={noticeRef} tabIndex={-1} role="status" className="text-sm text-success outline-none">{notice}</p>
            ) : null}
          </form>

          <UrlOverrideList
            rows={rows}
            search={search}
            onSearch={(value) => { setActionError(null); setSearch(value); }}
            loading={overridesQuery.isFetching}
            firstLoad={overridesQuery.isPending}
            loadError={overridesQuery.isError ? errorText(overridesQuery.error) : null}
            hasRows={overridesQuery.data !== undefined}
            onRetry={() => void overridesQuery.refetch()}
            onDelete={deleteRow}
            deleting={deleteOverride.isPending}
          />

          <UrlRecalcActions onError={setActionError} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChoiceNotice({ failed, empty, onRetry }: { failed: boolean; empty: boolean; onRetry: () => void }) {
  if (failed) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        Couldn't load the categories, so none can be chosen.
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>
      </p>
    );
  }
  if (empty) {
    return <p className="text-sm text-muted-foreground">There are no categories to choose from yet. Download the lists first, or turn categories on in Manage categories.</p>;
  }
  return null;
}
