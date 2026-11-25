import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField, SelectField, TextareaField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { Agent, AgentGroup, ScheduledScript } from "@/api/types";
import { useSchedulerTimezone } from "../hooks/useSchedulerTimezone";
import {
  defaultScheduledScriptForm,
  scheduledScriptFormToBody,
  scheduledScriptSchema,
  scheduledScriptToForm,
  TIMEOUT_MAX_SECS,
  TIMEOUT_MIN_SECS,
  type ScheduledScriptBody,
  type ScheduledScriptForm,
} from "../lib/scheduledScriptForm";
import { DialogError } from "./RuleTabParts";
import { ScopeRowsEditor } from "./ScopeRowsEditor";
import { ScriptScheduleEditor } from "./ScriptScheduleEditor";

const SHELL_OPTIONS = [
  { label: "PowerShell", value: "powershell" },
  { label: "CMD", value: "cmd" },
];

export type ScheduledScriptDialogTarget = null | { mode: "create" } | { mode: "edit"; script: ScheduledScript };

interface ScheduledScriptDialogProps {
  target: ScheduledScriptDialogTarget;
  groups: AgentGroup[];
  agents: Agent[];
  saving: boolean;
  /** Why the last save failed; shown here because the page behind the dialog is out of sight. */
  error?: string | null;
  onSave: (id: number | null, body: ScheduledScriptBody) => void;
  onClose: () => void;
}

/** Create/edit dialog for one scheduled script. It cannot be dismissed while the save is in flight. */
export function ScheduledScriptDialog({ target, onClose, ...rest }: ScheduledScriptDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !rest.saving) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words">{target?.mode === "edit" ? `Edit script · ${target.script.name}` : "New scheduled script"}</DialogTitle>
          <DialogDescription>Runs on each online device in scope. A device that is offline at the time skips that run.</DialogDescription>
        </DialogHeader>
        {target && <ScheduledScriptFormBody target={target} onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function ScheduledScriptFormBody({ target, groups, agents, saving, error, onSave, onClose }: Omit<ScheduledScriptDialogProps, "target"> & { target: NonNullable<ScheduledScriptDialogTarget> }) {
  const form = useForm<ScheduledScriptForm>({
    resolver: zodResolver(scheduledScriptSchema),
    defaultValues: target.mode === "edit" ? scheduledScriptToForm(target.script) : defaultScheduledScriptForm(),
  });
  const { control } = form;
  const timezone = useSchedulerTimezone();

  const submit = form.handleSubmit((values) => {
    onSave(target.mode === "create" ? null : target.script.id, scheduledScriptFormToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-5 border-0 p-0">
        <div className="grid gap-4 sm:grid-cols-[1fr_minmax(0,12rem)]">
          <InputField control={control} name="name" id="script-name" label="Script name" className="h-9" placeholder="e.g. Health check" />
          <SelectField control={control} name="shell" label="Shell" ariaLabel="Shell type" options={SHELL_OPTIONS} />
        </div>
        <TextareaField
          control={control}
          name="script"
          id="script-code"
          label="Script"
          rows={8}
          className="font-mono"
          description="Runs on each device in scope, as typed."
        />
        <InputField
          control={control}
          name="timeout_secs"
          id="script-timeout"
          label={`Timeout in seconds (${TIMEOUT_MIN_SECS} to ${TIMEOUT_MAX_SECS})`}
          className="h-9 sm:max-w-48"
          type="number"
        />

        <FormField control={control} name="scopes" label="Runs on" description="Which devices run this script. Add more rows to cover several groups or agents.">
          {({ field }) => <ScopeRowsEditor rows={field.value} onChange={field.onChange} groups={groups} agents={agents} divided={false} />}
        </FormField>

        <FormField control={control} name="schedules" label="Schedule">
          {({ field }) => <ScriptScheduleEditor rows={field.value} onChange={field.onChange} timezone={timezone} />}
        </FormField>
      </fieldset>
      <DialogError prefix="Couldn’t save the script" message={error} />
      <DialogFooter className="-bottom-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} {target.mode === "create" ? "Create script" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
