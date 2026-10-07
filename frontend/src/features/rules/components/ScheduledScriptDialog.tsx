import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { FormSelect } from "@/components/common/form/FormSelect";
import { settingsQueries } from "@/api/queries/settings";
import type { Agent, AgentGroup, ScheduledScript, ScheduledScriptSchedule } from "@/api/types";
import {
  defaultScheduledScriptForm,
  scheduledScriptFormToBody,
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
  /** Reports a validation message (or clears it with null). */
  onValidationError: (message: string | null) => void;
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

function ScheduledScriptFormBody({ target, groups, agents, saving, onSave, onValidationError, onClose }: Omit<ScheduledScriptDialogProps, "target"> & { target: NonNullable<ScheduledScriptDialogTarget> }) {
  const [form, setForm] = useState<ScheduledScriptForm>(() => (
    target.mode === "edit" ? scheduledScriptToForm(target.script) : defaultScheduledScriptForm()
  ));
  const schedulerTz = useQuery(settingsQueries.capabilities()).data?.scheduler_timezone || "UTC";

  const patchSchedule = (i: number, patch: Partial<ScriptScheduleRow>) => {
    const schedules = [...form.schedules];
    schedules[i] = { ...schedules[i], ...patch };
    setForm({ ...form, schedules });
  };

  const saveRule = () => {
    if (!form.name.trim()) { onValidationError("Name is required"); return; }
    if (!form.script.trim()) { onValidationError("Script is required"); return; }
    onValidationError(null);
    onSave(target.mode === "create" ? null : target.script.id, scheduledScriptFormToBody(form));
  };

  return (
    <>
      <div className="grid gap-6">
        <Field>
          <FieldLabel htmlFor="script-name">Script name</FieldLabel>
          <Input
            id="script-name"
            className="h-9"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="e.g. Health check script"
          />
        </Field>

        <Field>
          <FieldLabel>Shell type</FieldLabel>
          <FormSelect ariaLabel="Shell type" value={form.shell} options={SHELL_OPTIONS} onChange={(shell) => setForm({ ...form, shell })} />
        </Field>

        <Field>
          <FieldLabel htmlFor="script-code">Script code</FieldLabel>
          <Textarea
            id="script-code"
            value={form.script}
            onChange={(event) => setForm({ ...form, script: event.target.value })}
            rows={8}
            className="font-mono"
          />
          <FieldDescription>Script will execute on the remote agent machine.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="script-timeout">Timeout (seconds)</FieldLabel>
          <Input
            id="script-timeout"
            className="h-9"
            type="number"
            value={form.timeout_secs}
            onChange={(event) => setForm({ ...form, timeout_secs: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel>Scope</FieldLabel>
          <ScopeRowsEditor rows={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} groups={groups} agents={agents} divided={false} />
          <FieldDescription>Who this script runs on.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>Schedule (Timezone: {schedulerTz})</FieldLabel>
          <div className="flex flex-col gap-3">
            {form.schedules.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                <div className="min-w-32 flex-1">
                  <FormSelect
                    ariaLabel={`Schedule ${i + 1} frequency`}
                    value={s.frequency}
                    options={FREQUENCY_OPTIONS}
                    onChange={(value) => patchSchedule(i, { frequency: value as ScheduledScriptSchedule["frequency"] })}
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
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={saveRule} disabled={saving}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </>
  );
}
