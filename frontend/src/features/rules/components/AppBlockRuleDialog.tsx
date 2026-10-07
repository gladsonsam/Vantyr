import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
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
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

const MATCH_OPTIONS = [
  { label: "Contains", value: "contains" },
  { label: "Exact", value: "exact" },
];

export type AppBlockRuleDialogTarget = null | { mode: "create" } | { mode: "edit"; rule: AppBlockRule };

interface AppBlockRuleDialogProps {
  target: AppBlockRuleDialogTarget;
  groups: AgentGroup[];
  agents: Agent[];
  /** Seeds the scope of a legacy single-agent rule. */
  contextAgentId: string;
  saving: boolean;
  onSave: (id: number | null, body: AppBlockRuleBody) => void;
  onClose: () => void;
}

/** Create/edit dialog for one app block rule. */
export function AppBlockRuleDialog({ target, onClose, ...rest }: AppBlockRuleDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "edit"
              ? `Edit app block rule — ${target.rule.name || target.rule.exe_pattern || ""}`
              : "Add app block rule"}
          </DialogTitle>
        </DialogHeader>
        {target && <AppBlockRuleFormBody target={target} onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function AppBlockRuleFormBody({ target, groups, agents, contextAgentId, saving, onSave, onClose }: Omit<AppBlockRuleDialogProps, "target"> & { target: NonNullable<AppBlockRuleDialogTarget> }) {
  const form = useForm<AppBlockForm>({
    resolver: zodResolver(appBlockSchema),
    defaultValues: target.mode === "edit" ? appBlockRuleToForm(target.rule, contextAgentId) : defaultAppBlockForm(),
  });
  const { control } = form;
  const scheduled = useWatch({ control, name: "scheduled" });

  const submit = form.handleSubmit((values) => {
    onSave(target.mode === "create" ? null : target.rule.id, appBlockFormToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="grid gap-6">
        <InputField
          control={control}
          name="exe_pattern"
          id="appblock-exe"
          label="EXE name"
          className="h-9"
          placeholder="e.g. tiktok.exe"
          description="Executable file name to block (e.g. tiktok.exe)."
        />
        <ToggleGroupField control={control} name="match_mode" label="Match mode" ariaLabel="Match mode" options={MATCH_OPTIONS} />
        <InputField control={control} name="label" id="appblock-label" label="Label" className="h-9" placeholder="Optional" />
        <FormField control={control} name="scopes" label="Scope" description="Which agents this rule applies to.">
          {({ field }) => <ScopeRowsEditor rows={field.value} onChange={field.onChange} groups={groups} agents={agents} />}
        </FormField>

        <Field>
          <FieldLabel>Schedule (optional)</FieldLabel>
          <div className="flex flex-col gap-3">
            <CheckboxField control={control} name="scheduled" label="Enable schedule (curfew)" />
            {scheduled && (
              <FormField control={control} name="schedule_rows">
                {({ field }) => <ScheduleRowsEditor rows={field.value} onChange={field.onChange} />}
              </FormField>
            )}
          </div>
          <FieldDescription>
            If enabled, this rule only applies during these windows in the agent&apos;s local time. Overnight windows are supported (e.g. 22:00 → 06:00).
          </FieldDescription>
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} {target.mode === "create" ? "Add rule" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
