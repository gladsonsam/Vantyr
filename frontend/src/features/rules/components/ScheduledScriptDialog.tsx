import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
import { Input } from "@vantyr/ui/components/input";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField, SelectField, TextareaField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import { FormSelect } from "@/components/common/form/FormSelect";
import { settingsQueries } from "@/api/queries/settings";
import type { Agent, AgentGroup, ScheduledScript } from "@/api/types";
import {
  defaultScheduledScriptForm,
  scheduledScriptFormToBody,
  scheduledScriptSchema,
  scheduledScriptToForm,
  type ScheduledScriptBody,
  type ScheduledScriptForm,
  type ScriptScheduleRow,
} from "../lib/scheduledScriptForm";
import { DAY_OPTIONS } from "../rulesUtils";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

const FREQUENCY_OPTIONS = [
  { label: "hourly", value: "hourly" },
  { label: "daily", value: "daily" },
  { label: "weekly", value: "weekly" },
];

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
  onSave: (id: number | null, body: ScheduledScriptBody) => void;
  onClose: () => void;
}

/** Create/edit dialog for one scheduled script. */
export function ScheduledScriptDialog({ target, onClose, ...rest }: ScheduledScriptDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target?.mode === "edit" ? `Edit scheduled script — ${target.script.name}` : "New scheduled script"}</DialogTitle>
        </DialogHeader>
        {target && <ScheduledScriptFormBody target={target} onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function ScheduledScriptFormBody({ target, groups, agents, saving, onSave, onClose }: Omit<ScheduledScriptDialogProps, "target"> & { target: NonNullable<ScheduledScriptDialogTarget> }) {
  const form = useForm<ScheduledScriptForm>({
    resolver: zodResolver(scheduledScriptSchema),
    defaultValues: target.mode === "edit" ? scheduledScriptToForm(target.script) : defaultScheduledScriptForm(),
  });
  const { control } = form;
  const schedulerTz = useQuery(settingsQueries.capabilities()).data?.scheduler_timezone || "UTC";

  const submit = form.handleSubmit((values) => {
    onSave(target.mode === "create" ? null : target.script.id, scheduledScriptFormToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="grid gap-6">
        <InputField control={control} name="name" id="script-name" label="Script name" className="h-9" placeholder="e.g. Health check script" />
        <SelectField control={control} name="shell" label="Shell type" ariaLabel="Shell type" options={SHELL_OPTIONS} />
        <TextareaField
          control={control}
          name="script"
          id="script-code"
          label="Script code"
          rows={8}
          className="font-mono"
          description="Script will execute on the remote agent machine."
        />
        <InputField control={control} name="timeout_secs" id="script-timeout" label="Timeout (seconds)" className="h-9" type="number" />

        <FormField control={control} name="scopes" label="Scope" description="Who this script runs on.">
          {({ field }) => <ScopeRowsEditor rows={field.value} onChange={field.onChange} groups={groups} agents={agents} divided={false} />}
        </FormField>

        <FormField control={control} name="schedules" label={`Schedule (Timezone: ${schedulerTz})`}>
          {({ field }) => {
            const patchSchedule = (i: number, patch: Partial<ScriptScheduleRow>) => {
              const next = [...field.value];
              next[i] = { ...next[i], ...patch };
              field.onChange(next);
            };
            return (
              <div className="flex flex-col gap-3">
                {field.value.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                    <div className="min-w-32 flex-1">
                      <FormSelect
                        ariaLabel={`Schedule ${i + 1} frequency`}
                        value={s.frequency}
                        options={FREQUENCY_OPTIONS}
                        onChange={(value) => patchSchedule(i, { frequency: value as ScriptScheduleRow["frequency"] })}
                      />
                    </div>
                    {s.frequency === "weekly" && (
                      <div className="min-w-32 flex-1">
                        <FormSelect
                          ariaLabel={`Schedule ${i + 1} day`}
                          value={String(s.day_of_week ?? 1)}
                          options={DAY_OPTIONS}
                          onChange={(value) => patchSchedule(i, { day_of_week: Number(value) })}
                        />
                      </div>
                    )}
                    <Input
                      aria-label={`Schedule ${i + 1} time`}
                      className="h-9 w-28"
                      value={s.timeStr}
                      onChange={(event) => patchSchedule(i, { timeStr: event.target.value })}
                      placeholder={s.frequency === "hourly" ? "Minute (0-59)" : "HH:MM"}
                    />
                  </div>
                ))}
              </div>
            );
          }}
        </FormField>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
