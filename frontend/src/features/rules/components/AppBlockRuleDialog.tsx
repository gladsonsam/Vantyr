import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { CheckboxField, InputField, ToggleGroupField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";
import {
  appBlockFormToBody,
  appBlockRuleToForm,
  appBlockSchema,
  defaultAppBlockForm,
  type AppBlockForm,
  type AppBlockRuleBody,
} from "../lib/appBlockForm";
import { DialogError } from "./RuleTabParts";
import { RuleScheduleSection } from "./RuleScheduleSection";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

const MATCH_OPTIONS = [
  { label: "Contains", value: "contains" },
  { label: "Exact", value: "exact" },
];

export type AppBlockRuleDialogTarget =
  null | { mode: "create" } | { mode: "edit"; rule: AppBlockRule };

interface AppBlockRuleDialogProps {
  target: AppBlockRuleDialogTarget;
  groups: AgentGroup[];
  agents: Agent[];
  /** Seeds the scope of a legacy single-agent rule. */
  contextAgentId: string;
  saving: boolean;
  /** Why the last save failed; shown here because the page behind the dialog is out of sight. */
  error?: string | null;
  onSave: (id: number | null, body: AppBlockRuleBody) => void;
  onClose: () => void;
}

/** Create/edit dialog for one app block rule. It cannot be dismissed while the save is in flight. */
export function AppBlockRuleDialog({ target, onClose, ...rest }: AppBlockRuleDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !rest.saving) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "edit" ? "Edit app block rule" : "New app block rule"}
          </DialogTitle>
          <DialogDescription>
            Closes the app each time it starts on a device in scope.
          </DialogDescription>
        </DialogHeader>
        {target && <AppBlockRuleFormBody target={target} onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function AppBlockRuleFormBody({
  target,
  groups,
  agents,
  contextAgentId,
  saving,
  error,
  onSave,
  onClose,
}: Omit<AppBlockRuleDialogProps, "target"> & { target: NonNullable<AppBlockRuleDialogTarget> }) {
  const form = useForm<AppBlockForm>({
    resolver: zodResolver(appBlockSchema),
    defaultValues:
      target.mode === "edit"
        ? appBlockRuleToForm(target.rule, contextAgentId)
        : defaultAppBlockForm(),
  });
  const { control } = form;
  const scheduled = useWatch({ control, name: "scheduled" });

  const submit = form.handleSubmit((values) => {
    onSave(target.mode === "create" ? null : target.rule.id, appBlockFormToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-5 border-0 p-0">
        <InputField
          control={control}
          name="exe_pattern"
          id="appblock-exe"
          label="App (EXE name)"
          className="h-9"
          placeholder="e.g. tiktok.exe"
          description="The executable file name to close, e.g. tiktok.exe."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <ToggleGroupField
            control={control}
            name="match_mode"
            label="Match"
            ariaLabel="Match mode"
            options={MATCH_OPTIONS}
          />
          <InputField
            control={control}
            name="label"
            id="appblock-label"
            label="Label (optional)"
            className="h-9"
            placeholder="Shown in the list"
          />
        </div>
        <FormField
          control={control}
          name="scopes"
          label="Applies to"
          description="Which devices close this app. Add more rows to cover several groups or devices."
        >
          {({ field }) => (
            <ScopeRowsEditor
              rows={field.value}
              onChange={field.onChange}
              groups={groups}
              agents={agents}
            />
          )}
        </FormField>

        <RuleScheduleSection
          toggle={
            <CheckboxField control={control} name="scheduled" label="Only during set hours" />
          }
        >
          {scheduled && (
            <FormField control={control} name="schedule_rows">
              {({ field }) => <ScheduleRowsEditor rows={field.value} onChange={field.onChange} />}
            </FormField>
          )}
        </RuleScheduleSection>
      </fieldset>
      <DialogError prefix="Couldn’t save the rule" message={error} />
      <DialogFooter className="-bottom-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} {target.mode === "create" ? "Add rule" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
