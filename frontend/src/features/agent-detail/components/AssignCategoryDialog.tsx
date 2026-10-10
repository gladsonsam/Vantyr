import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api } from "@/api";
import { analyticsKeys } from "@/api/queries/analytics";
import { urlCategoryQueries } from "@/api/queries/urlCategories";
import { CheckboxField, TextareaField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import {
  toCategoryOptions,
  toCustomGroups,
  type CategoryOption,
  type CustomGroup,
} from "@/features/agent-detail/lib/analytics";
import {
  ASSIGN_CATEGORY_DEFAULTS,
  assignCategorySchema,
  defaultCategoryKey,
  specificCategoryOptions,
  toOverrideBody,
  type AssignCategoryValues,
  type AssignTarget,
} from "@/features/agent-detail/lib/assignCategoryForm";

const NO_OPTIONS: CategoryOption[] = [];
const NO_GROUPS: CustomGroup[] = [];

interface AssignCategoryDialogProps {
  /** What to categorise; null keeps the dialog closed. */
  target: AssignTarget | null;
  agentId: string;
  /** Overrides and the session recalculation are admin-only on the backend. */
  canAdmin: boolean;
  onClose: () => void;
}

/** Assign a (custom) category to a domain or URL prefix seen in an agent's browsing. */
export function AssignCategoryDialog({ target, agentId, canAdmin, onClose }: AssignCategoryDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        {target && <AssignCategoryForm target={target} agentId={agentId} canAdmin={canAdmin} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function AssignCategoryForm({ target, agentId, canAdmin, onClose }: Omit<AssignCategoryDialogProps, "target"> & { target: AssignTarget }) {
  const queryClient = useQueryClient();

  // Category list for quick assignment UX (best-effort; assigning still works without it).
  const categoryOptionsQuery = useQuery({ ...urlCategoryQueries.categories(), select: toCategoryOptions });
  const categoryOptions = categoryOptionsQuery.data ?? NO_OPTIONS;

  // Fetched once, then refreshed only when categories change.
  const customGroupsQuery = useQuery({ ...urlCategoryQueries.customCategories(), staleTime: Infinity, select: toCustomGroups });
  const customGroups = customGroupsQuery.data ?? NO_GROUPS;

  const form = useForm<AssignCategoryValues>({
    resolver: zodResolver(assignCategorySchema),
    mode: "onChange",
    defaultValues: ASSIGN_CATEGORY_DEFAULTS,
  });
  const { isValid } = form.formState;
  const customKey = useWatch({ control: form.control, name: "customKey" });
  const specific = useWatch({ control: form.control, name: "specific" });
  const customOptions = customGroups.map((g) => ({ value: g.key, label: g.label }));

  const assign = useMutation({
    mutationFn: (body: ReturnType<typeof toOverrideBody>) => api.urlCategorizationOverridesUpsert(body),
    onSuccess: async () => {
      // Apply to recent sessions so the UI updates immediately.
      void api.urlCategorizationRecalcUrlSessions({ limit: 50_000 }).catch(() => {});
      onClose();
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.agent(agentId) });
    },
  });
  const saving = assign.isPending;

  const submit = form.handleSubmit((values) => {
    if (!canAdmin) return;
    assign.mutate(toOverrideBody(target, values));
  });

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Assign category</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5 text-sm">
          <span className="text-muted-foreground">Override type</span>
          <span>{target.kind === "domain" ? "Domain" : "URL prefix"}</span>
        </div>
        <div className="flex flex-col gap-0.5 text-sm">
          <span className="text-muted-foreground">Match value</span>
          <span className="font-mono text-[13px] wrap-break-word">{target.value}</span>
        </div>
        <FormField control={form.control} name="customKey" label="Category" id="assign-custom" hideError>
          {({ field }) => (
            <Select
              value={field.value}
              onValueChange={(v) => {
                field.onChange(v || "");
                // An underlying UT1 key keeps the override working with existing storage.
                form.setValue("categoryKey", defaultCategoryKey(v || "", customGroups), { shouldValidate: true });
              }}
            >
              <SelectTrigger id="assign-custom" className="w-full">
                <SelectValue placeholder="Select a custom category" />
              </SelectTrigger>
              <SelectContent>
                {customOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <CheckboxField control={form.control} name="specific" label="More specific" fieldClassName="pt-1" hideError />
        {specific ? (
          <FormField control={form.control} name="categoryKey" label="UT1 category" hideError>
            {({ field }) => (
              <Select value={field.value} disabled={!customKey} onValueChange={(v) => field.onChange(v || "")}>
                <SelectTrigger aria-label="UT1 category" className="w-full">
                  <SelectValue placeholder="Select a UT1 category" />
                </SelectTrigger>
                <SelectContent>
                  {specificCategoryOptions(customKey, customGroups, categoryOptions).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        ) : null}
        {!customKey ? (
          <p className="text-[13px] text-muted-foreground">
            No custom categories. Add one in Settings.
          </p>
        ) : null}
        <TextareaField control={form.control} name="note" id="assign-note" label="Note (optional)" rows={2} hideError />
        {target.kind === "domain" && target.url ? (
          <p className="text-[13px] text-muted-foreground">
            Use a URL prefix to match one path.
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !isValid}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
