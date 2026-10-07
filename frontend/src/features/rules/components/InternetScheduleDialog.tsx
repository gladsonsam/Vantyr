import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { FormField } from "@/components/common/form/FormField";
import type { InternetBlockRule } from "@/api/types";
import { internetScheduleSchema, type InternetScheduleForm } from "../lib/internetBlockForm";
import { emptyScheduleRow, expandScheduleRows, scheduleToRows, type ScheduleWindow } from "../lib/scheduleRows";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";

interface InternetScheduleDialogProps {
  rule: InternetBlockRule | null;
  saving: boolean;
  onSave: (rule: InternetBlockRule, schedules: ScheduleWindow[]) => void;
  onClose: () => void;
}

/** Edits just the schedule windows of an existing internet block rule. */
export function InternetScheduleDialog({ rule, saving, onSave, onClose }: InternetScheduleDialogProps) {
  return (
    <Dialog open={rule !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit schedule — {rule?.name || "Internet block"}</DialogTitle>
        </DialogHeader>
        {rule && <InternetScheduleFormBody rule={rule} saving={saving} onSave={onSave} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function InternetScheduleFormBody({ rule, saving, onSave, onClose }: Omit<InternetScheduleDialogProps, "rule"> & { rule: InternetBlockRule }) {
  const form = useForm<InternetScheduleForm>({
    resolver: zodResolver(internetScheduleSchema),
    defaultValues: { schedule_rows: scheduleToRows(rule.schedules) },
  });

  const submit = form.handleSubmit((values) => onSave(rule, expandScheduleRows(values.schedule_rows)));

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="grid gap-6">
        <p className="text-sm text-muted-foreground">
          Empty schedule means <strong className="text-foreground">Always</strong>. Overnight windows (22:00 → 06:00) are supported (split automatically).
        </p>
        <FormField control={form.control} name="schedule_rows">
          {({ field }) => <ScheduleRowsEditor rows={field.value} onChange={field.onChange} />}
        </FormField>
        <Button variant="ghost" size="sm" className="self-start" onClick={() => form.setValue("schedule_rows", [emptyScheduleRow()])}>
          Reset to Always
        </Button>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
