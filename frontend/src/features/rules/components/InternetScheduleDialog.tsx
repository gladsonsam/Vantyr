import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import { CheckboxField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { InternetBlockRule } from "@/api/types";
import { internetRuleTitle } from "../hooks/useInternetRuleMutations";
import { internetScheduleSchema, internetScheduleWindows, type InternetScheduleForm } from "../lib/internetBlockForm";
import { scheduleToRows, type ScheduleWindow } from "../lib/scheduleRows";
import { DialogError } from "./RuleTabParts";
import { RuleScheduleSection } from "./RuleScheduleSection";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";

interface InternetScheduleDialogProps {
  rule: InternetBlockRule | null;
  saving: boolean;
  /** Why the last save failed; shown here because the page behind the dialog is out of sight. */
  error?: string | null;
  onSave: (rule: InternetBlockRule, schedules: ScheduleWindow[]) => void;
  onClose: () => void;
}

/** Edits just the schedule of an existing internet block rule. It cannot be dismissed while saving. */
export function InternetScheduleDialog({ rule, saving, error, onSave, onClose }: InternetScheduleDialogProps) {
  return (
    <Dialog open={rule !== null} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words">Schedule · {rule ? internetRuleTitle(rule) : ""}</DialogTitle>
          <DialogDescription>When this rule blocks internet access.</DialogDescription>
        </DialogHeader>
        {rule && <InternetScheduleFormBody rule={rule} saving={saving} error={error} onSave={onSave} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function InternetScheduleFormBody({ rule, saving, error, onSave, onClose }: Omit<InternetScheduleDialogProps, "rule"> & { rule: InternetBlockRule }) {
  const form = useForm<InternetScheduleForm>({
    resolver: zodResolver(internetScheduleSchema),
    defaultValues: { scheduled: rule.schedules.length > 0, schedule_rows: scheduleToRows(rule.schedules) },
  });
  const { control } = form;
  const scheduled = useWatch({ control, name: "scheduled" });

  const submit = form.handleSubmit((values) => onSave(rule, internetScheduleWindows(values)));

  return (
    <form onSubmit={submit} noValidate className="contents">
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-5 border-0 p-0">
        <RuleScheduleSection toggle={<CheckboxField control={control} name="scheduled" label="Only during set hours" />}>
          {scheduled ? (
            <FormField control={control} name="schedule_rows">
              {({ field }) => <ScheduleRowsEditor rows={field.value} onChange={field.onChange} />}
            </FormField>
          ) : (
            <p className="text-sm text-muted-foreground">No set hours: this rule blocks <strong className="text-foreground">all the time</strong> while it is on.</p>
          )}
        </RuleScheduleSection>
        <p className="text-sm text-muted-foreground">
          {rule.enabled
            ? "Saved changes reach connected devices right away; offline devices get them when they reconnect."
            : "This rule is off, so a saved schedule doesn’t block anything until you turn it on."}
        </p>
      </fieldset>
      <DialogError prefix="Couldn’t save the schedule" message={error} />
      <DialogFooter className="-bottom-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} Save schedule
        </Button>
      </DialogFooter>
    </form>
  );
}
