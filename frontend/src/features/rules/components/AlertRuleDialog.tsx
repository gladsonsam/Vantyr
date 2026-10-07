import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FormSelect } from "@/components/common/form/FormSelect";
import type { Agent, AgentGroup, AlertRule, AlertRuleChannel, AlertRuleComparator, AlertRuleMatchMode, AlertRuleMetric, AlertRuleScopeKind } from "@/api/types";
import { alertRuleFormToBody, alertRuleToForm, defaultAlertRuleForm, isMonitoringChannel, type AlertRuleBody, type AlertRuleForm } from "../lib/alertRuleForm";
import { emptyScopeRow, type ScopeFormRow } from "../rulesUtils";

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
const SCOPE_OPTIONS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

export type AlertRuleDialogTarget = null | { mode: "create" } | { mode: "edit"; rule: AlertRule };

interface AlertRuleDialogProps {
  target: AlertRuleDialogTarget;
  groups: AgentGroup[];
  agents: Agent[];
  saving: boolean;
  onSave: (id: number | null, body: AlertRuleBody) => void;
  /** Reports a validation message (or clears it with null). */
  onValidationError: (message: string | null) => void;
  onClose: () => void;
}

/** Create/edit dialog for one alert rule. */
export function AlertRuleDialog({ target, groups, agents, saving, onSave, onValidationError, onClose }: AlertRuleDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target?.mode === "create" ? "New alert rule" : "Edit alert rule"}</DialogTitle>
        </DialogHeader>
        {target && (
          <AlertRuleFormBody target={target} groups={groups} agents={agents} saving={saving} onSave={onSave} onValidationError={onValidationError} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AlertRuleFormBody({ target, groups, agents, saving, onSave, onValidationError, onClose }: Omit<AlertRuleDialogProps, "target"> & { target: NonNullable<AlertRuleDialogTarget> }) {
  const [form, setForm] = useState<AlertRuleForm>(() => (target.mode === "edit" ? alertRuleToForm(target.rule) : defaultAlertRuleForm()));

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

  const updateScope = (i: number, patch: Partial<ScopeFormRow>) => {
    const scopes = [...form.scopes];
    const cur = { ...scopes[i], ...patch };
    if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
    if (patch.kind === "group") cur.agent_id = "";
    if (patch.kind === "agent") cur.group_id = "";
    scopes[i] = cur;
    setForm({ ...form, scopes });
  };

  const saveRule = () => {
    if (!isMonitoringChannel(form.channel) && !form.pattern.trim()) { onValidationError("Pattern is required"); return; }
    onValidationError(null);
    onSave(target.mode === "create" ? null : target.rule.id, alertRuleFormToBody(form));
  };

  return (
    <>
      <div className="grid gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="alert-rule-name">Name (optional)</FieldLabel>
            <Input
              id="alert-rule-name"
              className="h-9"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="e.g. High CPU"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="alert-rule-channel">Channel</FieldLabel>
            <FormSelect
              ariaLabel="Channel"
              value={form.channel}
              options={CHANNEL_OPTIONS}
              onChange={(value) => setForm({ ...form, channel: value as AlertRuleChannel })}
            />
          </Field>
        </div>

        {!isMonitoringChannel(form.channel) && (
          <>
            <Field>
              <FieldLabel htmlFor="alert-rule-pattern">Pattern</FieldLabel>
              <Input
                id="alert-rule-pattern"
                className="h-9"
                value={form.pattern}
                onChange={(event) => setForm({ ...form, pattern: event.target.value })}
                placeholder={form.channel === "url" ? "e.g. youtube.com" : form.channel === "url_category" ? "e.g. adult" : "e.g. password"}
              />
              <FieldDescription>
                {form.match_mode === "regex" ? "ECMAScript regular expression." : "Case-insensitive substring to match against."}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Match mode</FieldLabel>
              <ToggleGroup
                size="sm"
                spacing={0}
                className="rounded-lg bg-muted/70 p-0.5"
                aria-label="Match mode"
                value={[form.match_mode]}
                onValueChange={(value) => {
                  const next = value[0] as AlertRuleMatchMode | undefined;
                  if (next) setForm({ ...form, match_mode: next });
                }}
              >
                {MATCH_OPTIONS.map((o) => (
                  <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} className="rounded-md! px-3 aria-pressed:bg-background">
                    {o.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          </>
        )}

        {form.channel === "resource" && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Metric</FieldLabel>
                <FormSelect
                  ariaLabel="Metric"
                  value={form.metric}
                  options={METRIC_OPTIONS}
                  onChange={(value) => setForm({ ...form, metric: value as AlertRuleMetric })}
                />
              </Field>
              <Field>
                <FieldLabel>Condition</FieldLabel>
                <ToggleGroup
                  size="sm"
                  spacing={0}
                  className="rounded-lg bg-muted/70 p-0.5"
                  aria-label="Condition"
                  value={[form.comparator]}
                  onValueChange={(value) => {
                    const next = value[0] as AlertRuleComparator | undefined;
                    if (next) setForm({ ...form, comparator: next });
                  }}
                >
                  {COMPARATOR_OPTIONS.map((o) => (
                    <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} className="rounded-md! px-3 aria-pressed:bg-background">
                      {o.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="alert-rule-threshold">Threshold (%)</FieldLabel>
              <Input
                id="alert-rule-threshold"
                className="h-9"
                type="number"
                value={String(form.threshold)}
                onChange={(event) => setForm({ ...form, threshold: Math.min(100, Math.max(0, parseInt(event.target.value, 10) || 0)) })}
              />
              <FieldDescription>Alert when the metric crosses this percentage.</FieldDescription>
            </Field>
          </>
        )}

        {form.channel === "agent_offline" && (
          <Field>
            <FieldLabel htmlFor="alert-rule-duration">Offline for (minutes)</FieldLabel>
            <Input
              id="alert-rule-duration"
              className="h-9"
              type="number"
              value={String(form.duration_mins)}
              onChange={(event) => setForm({ ...form, duration_mins: Math.max(1, parseInt(event.target.value, 10) || 1) })}
            />
            <FieldDescription>Fire when the agent has had no contact for at least this long.</FieldDescription>
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="alert-rule-cooldown">Cooldown (seconds)</FieldLabel>
          <Input
            id="alert-rule-cooldown"
            className="h-9"
            type="number"
            value={String(form.cooldown_secs)}
            onChange={(event) => setForm({ ...form, cooldown_secs: Math.max(0, parseInt(event.target.value, 10) || 0) })}
          />
          <FieldDescription>Minimum seconds between repeated alerts for the same agent.</FieldDescription>
        </Field>

        <div className="flex flex-col gap-3">
          {!isMonitoringChannel(form.channel) && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={form.case_insensitive} onCheckedChange={(checked) => setForm({ ...form, case_insensitive: checked === true })} />
              Case insensitive
            </label>
          )}
          {form.channel !== "agent_offline" && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={form.take_screenshot} onCheckedChange={(checked) => setForm({ ...form, take_screenshot: checked === true })} />
              Take screenshot on trigger
            </label>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked === true })} />
            Enabled
          </label>
        </div>

        <Field>
          <FieldLabel>Scope</FieldLabel>
          <div className="flex flex-col gap-3">
            {form.scopes.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                <div className="min-w-36 flex-1">
                  <FormSelect
                    ariaLabel={`Scope ${i + 1} kind`}
                    value={s.kind}
                    options={SCOPE_OPTIONS}
                    onChange={(value) => updateScope(i, { kind: value as AlertRuleScopeKind })}
                  />
                </div>
                {s.kind === "group" && (
                  <div className="min-w-36 flex-1">
                    <FormSelect
                      ariaLabel={`Scope ${i + 1} group`}
                      placeholder="Select group"
                      value={s.group_id}
                      options={groupOptions}
                      onChange={(value) => updateScope(i, { group_id: value })}
                    />
                  </div>
                )}
                {s.kind === "agent" && (
                  <div className="min-w-36 flex-1">
                    <FormSelect
                      ariaLabel={`Scope ${i + 1} agent`}
                      placeholder="Select agent"
                      value={s.agent_id}
                      options={agentOptions}
                      onChange={(value) => updateScope(i, { agent_id: value })}
                    />
                  </div>
                )}
                {form.scopes.length > 1 && (
                  <Button variant="ghost" size="sm" aria-label={`Remove scope ${i + 1}`} onClick={() => setForm({ ...form, scopes: form.scopes.filter((_, j) => j !== i) })}>
                    <X /> Remove
                  </Button>
                )}
              </div>
            ))}
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setForm({ ...form, scopes: [...form.scopes, emptyScopeRow()] })}>
              <Plus /> Add scope
            </Button>
          </div>
          <FieldDescription>Which agents this rule monitors.</FieldDescription>
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={saveRule} disabled={saving}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </>
  );
}
