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
import { DialogError } from "./RuleTabParts";
import { RuleScheduleSection } from "./RuleScheduleSection";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

interface InternetBlockRuleDialogProps {
  open: boolean;
  groups: AgentGroup[];
  agents: Agent[];
  saving: boolean;
  /** Why the last save failed; shown here because the page behind the dialog is out of sight. */
  error?: string | null;
  onSave: (body: InternetBlockRuleBody) => void;
  onClose: () => void;
}

/** Create dialog for an internet block rule. It cannot be dismissed while the save is in flight. */
export function InternetBlockRuleDialog({ open, onClose, ...rest }: InternetBlockRuleDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !rest.saving) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New internet block rule</DialogTitle>
          <DialogDescription>
            Cuts internet access for the devices in scope. Their connection to Vantyr keeps working.
          </DialogDescription>
        </DialogHeader>
        {open && <InternetBlockRuleFormBody onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function InternetBlockRuleFormBody({
  groups,
  agents,
  saving,
  error,
  onSave,
  onClose,
}: Omit<InternetBlockRuleDialogProps, "open">) {
  const form = useForm<InternetBlockForm>({
    resolver: zodResolver(internetBlockSchema),
    defaultValues: defaultInternetBlockForm(),
  });
  const { control } = form;
  const scheduled = useWatch({ control, name: "scheduled" });

  const submit = form.handleSubmit((values) => onSave(internetBlockFormToBody(values)));

  return (
    <form onSubmit={submit} noValidate className="contents">
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-5 border-0 p-0">
        <InputField
          control={control}
          name="name"
          id="inet-name"
          label="Name (optional)"
          className="h-9"
          placeholder="e.g. Block school devices"
        />
        <FormField
          control={control}
          name="scopes"
          label="Blocks"
          description="Which devices lose internet access. Add more rows to cover several groups or agents."
        >
          {({ field }) => (
            <ScopeRowsEditor
              rows={field.value}
              onChange={field.onChange}
              groups={groups}
              agents={agents}
              divided={false}
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
        <p className="text-sm text-muted-foreground">
          {scheduled
            ? "Devices lose internet only during these hours, once they get the rule."
            : "With no schedule, connected devices lose internet right away; offline devices when they reconnect."}
        </p>
      </fieldset>
      <DialogError prefix="Couldn’t create the rule" message={error} />
      <DialogFooter className="-bottom-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} Create rule
        </Button>
      </DialogFooter>
    </form>
  );
}
