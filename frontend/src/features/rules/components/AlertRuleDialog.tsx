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
import {
  CheckboxField,
  InputField,
  NumberField,
  SelectField,
  ToggleGroupField,
} from "@/components/common/form/fields";
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
  { value: "substring", label: "Contains" },
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
  /** Why the last save failed; shown here because the page behind the dialog is out of sight. */
  error?: string | null;
  onSave: (id: number | null, body: AlertRuleBody) => void;
  onClose: () => void;
}

const PATTERN_HELP: Record<string, { placeholder: string; help: string }> = {
  url: {
    placeholder: "e.g. youtube.com",
    help: "Checked against every web address the agent visits.",
  },
  url_category: {
    placeholder: "e.g. adult",
    help: "The category name a visited site was filed under.",
  },
  keys: { placeholder: "e.g. password", help: "Checked against what is typed on the agent." },
};

/** Create/edit dialog for one alert rule. It cannot be dismissed while the save is in flight. */
export function AlertRuleDialog({
  target,
  groups,
  agents,
  saving,
  error,
  onSave,
  onClose,
}: AlertRuleDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "edit" ? "Edit alert rule" : "New alert rule"}
          </DialogTitle>
          <DialogDescription>Raises an alert when an agent in its scope matches.</DialogDescription>
        </DialogHeader>
        {target && (
          <AlertRuleFormBody
            target={target}
            groups={groups}
            agents={agents}
            saving={saving}
            error={error}
            onSave={onSave}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AlertRuleFormBody({
  target,
  groups,
  agents,
  saving,
  error,
  onSave,
  onClose,
}: Omit<AlertRuleDialogProps, "target"> & { target: NonNullable<AlertRuleDialogTarget> }) {
  const form = useForm<AlertRuleForm>({
    resolver: zodResolver(alertRuleSchema),
    defaultValues: target.mode === "edit" ? alertRuleToForm(target.rule) : defaultAlertRuleForm(),
  });
  const { control } = form;
  const channel = useWatch({ control, name: "channel" });
  const matchMode = useWatch({ control, name: "match_mode" });
  const pattern = PATTERN_HELP[channel] ?? PATTERN_HELP.url;

  const submit = form.handleSubmit((values) => {
    onSave(target.mode === "create" ? null : target.rule.id, alertRuleFormToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-5 border-0 p-0">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InputField
            control={control}
            name="name"
            id="alert-rule-name"
            label="Name (optional)"
            className="h-9"
            placeholder="e.g. High CPU"
          />
          <SelectField
            control={control}
            name="channel"
            id="alert-rule-channel"
            label="Channel"
            ariaLabel="Channel"
            options={CHANNEL_OPTIONS}
          />
        </div>

        {!isMonitoringChannel(channel) && (
          <div className="grid gap-4">
            <InputField
              control={control}
              name="pattern"
              id="alert-rule-pattern"
              label="Pattern"
              className="h-9"
              placeholder={pattern.placeholder}
              description={`${pattern.help} ${matchMode === "regex" ? "Rust regular-expression syntax." : "Plain text found anywhere in it."}`}
            />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <ToggleGroupField
                control={control}
                name="match_mode"
                label="Match mode"
                ariaLabel="Match mode"
                options={MATCH_OPTIONS}
              />
              <CheckboxField control={control} name="case_insensitive" label="Case insensitive" />
            </div>
          </div>
        )}

        {channel === "resource" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SelectField
              control={control}
              name="metric"
              label="Metric"
              ariaLabel="Metric"
              options={METRIC_OPTIONS}
            />
            <ToggleGroupField
              control={control}
              name="comparator"
              label="Condition"
              ariaLabel="Condition"
              options={COMPARATOR_OPTIONS}
            />
            <NumberField
              control={control}
              name="threshold"
              id="alert-rule-threshold"
              label="Threshold (%)"
              className="h-9"
              parse={parseThreshold}
              description="Alert when the metric crosses this percentage."
            />
          </div>
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

        <FormField
          control={control}
          name="scopes"
          label="Applies to"
          description="Which agents this rule monitors. Add more rows to cover several groups or agents."
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

        <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-end">
          <NumberField
            control={control}
            name="cooldown_secs"
            id="alert-rule-cooldown"
            label="Cooldown (seconds)"
            className="h-9"
            parse={parseCooldown}
            description="Minimum seconds between repeated alerts for the same agent. 0 alerts on every match."
          />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pb-1.5">
            {channel !== "agent_offline" && (
              <CheckboxField
                control={control}
                name="take_screenshot"
                label="Take screenshot on trigger"
              />
            )}
            <CheckboxField control={control} name="enabled" label="Enabled" />
          </div>
        </div>
      </fieldset>
      {error && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive"
        >
          Couldn’t save the rule: {error}
        </div>
      )}
      <DialogFooter className="-bottom-4">
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />} {target.mode === "create" ? "Create rule" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
