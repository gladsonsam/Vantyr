import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { CheckboxField, InputField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { Agent, AgentGroup } from "@/api/types";
import {
  defaultInternetBlockForm,
  internetBlockFormToBody,
  internetBlockSchema,
  type InternetBlockForm,
  type InternetBlockRuleBody,
} from "../lib/internetBlockForm";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

interface InternetBlockRuleDialogProps {
  open: boolean;
  groups: AgentGroup[];
  agents: Agent[];
  saving: boolean;
  onSave: (body: InternetBlockRuleBody) => void;
  onClose: () => void;
}

/** Create dialog for an internet block rule. */
export function InternetBlockRuleDialog({ open, onClose, ...rest }: InternetBlockRuleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New internet block rule</DialogTitle>
        </DialogHeader>
        {open && <InternetBlockRuleFormBody onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function InternetBlockRuleFormBody({ groups, agents, saving, onSave, onClose }: Omit<InternetBlockRuleDialogProps, "open">) {
  const form = useForm<InternetBlockForm>({
    resolver: zodResolver(internetBlockSchema),
    defaultValues: defaultInternetBlockForm(),
  });
  const { control } = form;
  const scheduled = useWatch({ control, name: "scheduled" });

  const submit = form.handleSubmit((values) => onSave(internetBlockFormToBody(values)));

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="grid gap-6">
        <InputField control={control} name="name" id="inet-name" label="Name (optional)" className="h-9" placeholder="e.g. Block school devices" />
        <FormField control={control} name="scopes" label="Scope" description="Who this rule blocks.">
          {({ field }) => <ScopeRowsEditor rows={field.value} onChange={field.onChange} groups={groups} agents={agents} divided={false} />}
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
            {scheduled && (
              <p className="text-xs text-muted-foreground">
                Overnight windows (e.g. 22:00 → 06:00) are supported (they’ll be split across days automatically).
              </p>
            )}
          </div>
          <FieldDescription>If enabled, this rule only applies during these windows in the agent’s local time.</FieldDescription>
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} Create
        </Button>
      </DialogFooter>
    </form>
  );
}
