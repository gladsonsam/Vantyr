import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { CheckboxField, InputField, NumberField, SelectField, ToggleGroupField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { Agent, AgentGroup, AlertRule } from "@/api/types";
import {
  alertRuleFormToBody,
  alertRuleSchema,
  alertRuleToForm,
  defaultAlertRuleForm,
  isMonitoringChannel,
  type AlertRuleBody,
  type AlertRuleForm,
} from "../lib/alertRuleForm";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

const CHANNEL_OPTIONS = [
  { label: "URL", value: "url" },
  { label: "URL category", value: "url_category" },
  { label: "Keystrokes", value: "keys" },
  { label: "Resource threshold", value: "resource" },
  { label: "Agent offline", value: "agent_offline" },
];
const MATCH_OPTIONS = [
  { value: "substring", label: "Substring" },
  { value: "regex", label: "Regex" },
];
const METRIC_OPTIONS = [
  { label: "CPU usage", value: "cpu_pct" },
  { label: "Memory usage", value: "mem_pct" },
  { label: "Disk usage", value: "disk_pct" },
];
const COMPARATOR_OPTIONS = [
  { value: "gt", label: "Above" },
  { value: "lt", label: "Below" },
];
const parseThreshold = (raw: string) => Math.min(100, Math.max(0, parseInt(raw, 10) || 0));
const parseDuration = (raw: string) => Math.max(1, parseInt(raw, 10) || 1);
const parseCooldown = (raw: string) => Math.max(0, parseInt(raw, 10) || 0);

export type AlertRuleDialogTarget = null | { mode: "create" } | { mode: "edit"; rule: AlertRule };

interface AlertRuleDialogProps {
  target: AlertRuleDialogTarget;
  groups: AgentGroup[];
  agents: Agent[];
  saving: boolean;
  onSave: (id: number | null, body: AlertRuleBody) => void;
  onClose: () => void;
}

/** Create/edit dialog for one alert rule. */
export function AlertRuleDialog({ target, groups, agents, saving, onSave, onClose }: AlertRuleDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target?.mode === "create" ? "New alert rule" : "Edit alert rule"}</DialogTitle>
        </DialogHeader>
        {target && (
          <AlertRuleFormBody target={target} groups={groups} agents={agents} saving={saving} onSave={onSave} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AlertRuleFormBody({ target, groups, agents, saving, onSave, onClose }: Omit<AlertRuleDialogProps, "target"> & { target: NonNullable<AlertRuleDialogTarget> }) {
  const form = useForm<AlertRuleForm>({
    resolver: zodResolver(alertRuleSchema),
    defaultValues: target.mode === "edit" ? alertRuleToForm(target.rule) : defaultAlertRuleForm(),
  });
  const { control } = form;
  const channel = useWatch({ control, name: "channel" });
  const matchMode = useWatch({ control, name: "match_mode" });

  const submit = form.handleSubmit((values) => {
    onSave(target.mode === "create" ? null : target.rule.id, alertRuleFormToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="grid gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InputField control={control} name="name" id="alert-rule-name" label="Name (optional)" className="h-9" placeholder="e.g. High CPU" />
          <SelectField control={control} name="channel" id="alert-rule-channel" label="Channel" ariaLabel="Channel" options={CHANNEL_OPTIONS} />
        </div>

        {!isMonitoringChannel(channel) && (
          <>
            <InputField
              control={control}
              name="pattern"
              id="alert-rule-pattern"
              label="Pattern"
              className="h-9"
              placeholder={channel === "url" ? "e.g. youtube.com" : channel === "url_category" ? "e.g. adult" : "e.g. password"}
              description={matchMode === "regex" ? "ECMAScript regular expression." : "Case-insensitive substring to match against."}
            />
            <ToggleGroupField control={control} name="match_mode" label="Match mode" ariaLabel="Match mode" options={MATCH_OPTIONS} />
          </>
        )}

        {channel === "resource" && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField control={control} name="metric" label="Metric" ariaLabel="Metric" options={METRIC_OPTIONS} />
              <ToggleGroupField control={control} name="comparator" label="Condition" ariaLabel="Condition" options={COMPARATOR_OPTIONS} />
            </div>
            <NumberField
              control={control}
              name="threshold"
              id="alert-rule-threshold"
              label="Threshold (%)"
              className="h-9"
              parse={parseThreshold}
              description="Alert when the metric crosses this percentage."
            />
          </>
        )}

        {channel === "agent_offline" && (
          <NumberField
            control={control}
            name="duration_mins"
            id="alert-rule-duration"
            label="Offline for (minutes)"
            className="h-9"
            parse={parseDuration}
            description="Fire when the agent has had no contact for at least this long."
          />
        )}

        <NumberField
          control={control}
          name="cooldown_secs"
          id="alert-rule-cooldown"
          label="Cooldown (seconds)"
          className="h-9"
          parse={parseCooldown}
          description="Minimum seconds between repeated alerts for the same agent."
        />

        <div className="flex flex-col gap-3">
          {!isMonitoringChannel(channel) && <CheckboxField control={control} name="case_insensitive" label="Case insensitive" />}
          {channel !== "agent_offline" && <CheckboxField control={control} name="take_screenshot" label="Take screenshot on trigger" />}
          <CheckboxField control={control} name="enabled" label="Enabled" />
        </div>

        <FormField control={control} name="scopes" label="Scope" description="Which agents this rule monitors.">
          {({ field }) => <ScopeRowsEditor rows={field.value} onChange={field.onChange} groups={groups} agents={agents} />}
        </FormField>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
