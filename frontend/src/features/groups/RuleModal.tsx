import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Field, FieldLabel } from "@vantyr/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField, NumberField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import { cn } from "@/lib/utils";
import type {
  AlertRule,
  AlertRuleChannel,
  AlertRuleMatchMode,
  AlertRuleScopeKind,
} from "@/api/types";
import { groupRuleSchema, type GroupRuleValues, type RuleScopeRow } from "./groupSchemas";

interface RuleModalProps {
  visible: boolean;
  onDismiss: () => void;
  rule: AlertRule | null; // null for create
  /** Kept for compatibility; layout is responsive and ignores it. */
  isNarrow?: boolean;
  agentOptions: { label: string; value: string }[];
  groupOptions: { label: string; value: string }[];
  onSave: (data: GroupRuleValues) => Promise<void>;
}

const CHANNEL_OPTIONS: { label: string; value: AlertRuleChannel }[] = [
  { label: "URL", value: "url" },
  { label: "Keystrokes", value: "keys" },
];

const MATCH_OPTIONS: { label: string; value: AlertRuleMatchMode }[] = [
  { label: "Substring", value: "substring" },
  { label: "Regex", value: "regex" },
];

const SCOPE_KIND_OPTIONS: { label: string; value: AlertRuleScopeKind }[] = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

function emptyScopeRow(): RuleScopeRow {
  return { kind: "all", group_id: "", agent_id: "" };
}

function ruleToValues(rule: AlertRule | null): GroupRuleValues {
  if (!rule) {
    return {
      name: "", channel: "url", pattern: "", match_mode: "substring", case_insensitive: true,
      cooldown_secs: 300, enabled: true, take_screenshot: false, scopes: [emptyScopeRow()],
    };
  }
  return {
    name: rule.name,
    channel: rule.channel,
    pattern: rule.pattern,
    match_mode: rule.match_mode,
    case_insensitive: rule.case_insensitive,
    cooldown_secs: rule.cooldown_secs,
    enabled: rule.enabled,
    take_screenshot: Boolean(rule.take_screenshot),
    scopes: rule.scopes.length === 0
      ? [emptyScopeRow()]
      : rule.scopes.map((s) => ({ kind: s.kind, group_id: s.group_id ?? "", agent_id: s.agent_id ?? "" })),
  };
}

function updateScopeRow(rows: RuleScopeRow[], index: number, patch: Partial<RuleScopeRow>): RuleScopeRow[] {
  const next = [...rows];
  const cur = { ...next[index], ...patch };
  if (patch.kind === "all") {
    cur.group_id = "";
    cur.agent_id = "";
  } else if (patch.kind === "group") {
    cur.agent_id = "";
  } else if (patch.kind === "agent") {
    cur.group_id = "";
  }
  next[index] = cur;
  return next;
}

function CheckRow({ checked, disabled, onChange, label }: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}

export function RuleModal({ visible, onDismiss, rule, agentOptions, groupOptions, onSave }: RuleModalProps) {
  // The dialog can't be dismissed while the save request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {visible && (
          <RuleForm rule={rule} agentOptions={agentOptions} groupOptions={groupOptions} onDismiss={onDismiss} onSave={onSave} onBusyChange={setBusy} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuleForm({ rule, agentOptions, groupOptions, onDismiss, onSave, onBusyChange }: Omit<RuleModalProps, "visible"> & { onBusyChange: (busy: boolean) => void }) {
  const form = useForm<GroupRuleValues>({
    resolver: zodResolver(groupRuleSchema),
    mode: "onChange",
    defaultValues: ruleToValues(rule),
  });
  const { control } = form;
  const { isSubmitting } = form.formState;
  const matchMode = useWatch({ control, name: "match_mode" });
  const patternFilled = useWatch({ control, name: "pattern" }).trim() !== "";

  const submit = form.handleSubmit(async (values) => {
    onBusyChange(true);
    try {
      await onSave(values);
      onDismiss();
    } catch {
      // Handled by parent
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{rule ? "Edit alert rule" : "Create alert rule"}</DialogTitle>
      </DialogHeader>

      <InputField control={control} name="name" id="rule-name" label="Display name" autoFocus disabled={isSubmitting} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField control={control} name="channel" id="rule-channel" label="Channel">
          {({ field, id }) => (
            <Select value={field.value} onValueChange={(v) => field.onChange(v as AlertRuleChannel)} disabled={isSubmitting}>
              <SelectTrigger id={id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField control={control} name="match_mode" id="rule-match" label="Match mode">
          {({ field, id }) => (
            <Select value={field.value} onValueChange={(v) => field.onChange(v as AlertRuleMatchMode)} disabled={isSubmitting}>
              <SelectTrigger id={id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCH_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </div>

      <InputField
        control={control}
        name="pattern"
        id="rule-pattern"
        label="Pattern"
        disabled={isSubmitting}
        hideError
        description={matchMode === "regex"
          ? "Rust regex; case sensitivity follows the checkbox below."
          : "Substring match."}
      />

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <FormField control={control} name="case_insensitive" className="w-auto">
          {({ field }) => <CheckRow checked={field.value} disabled={isSubmitting} onChange={field.onChange} label="Case-insensitive" />}
        </FormField>
        <FormField control={control} name="take_screenshot" className="w-auto">
          {({ field }) => <CheckRow checked={field.value} disabled={isSubmitting} onChange={field.onChange} label="Take screenshot on trigger" />}
        </FormField>
        <FormField control={control} name="enabled" className="w-auto">
          {({ field }) => <CheckRow checked={field.value} disabled={isSubmitting} onChange={field.onChange} label="Enabled" />}
        </FormField>
      </div>

      <NumberField
        control={control}
        name="cooldown_secs"
        id="rule-cooldown"
        label="Cooldown (seconds)"
        min={0}
        disabled={isSubmitting}
        parse={(raw) => {
          const n = parseInt(raw, 10);
          return Number.isFinite(n) ? Math.max(0, n) : 0;
        }}
        description="0 = fire every matching event (can be noisy)."
      />

      <FormField control={control} name="scopes">
        {({ field }) => {
          const scopes = field.value;
          return (
            <div className="grid gap-2">
              <div className="text-sm font-medium">Scopes</div>
              {scopes.map((row, index) => (
                <div key={index} className="rounded-lg bg-muted/50 p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field className="min-w-36 flex-1">
                      <FieldLabel htmlFor={`scope-kind-${index}`}>Applies to</FieldLabel>
                      <Select
                        value={row.kind}
                        onValueChange={(v) => field.onChange(updateScopeRow(scopes, index, { kind: v as AlertRuleScopeKind }))}
                        disabled={isSubmitting}
                      >
                        <SelectTrigger id={`scope-kind-${index}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SCOPE_KIND_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    {row.kind === "group" && (
                      <Field className="min-w-36 flex-1">
                        <FieldLabel htmlFor={`scope-group-${index}`}>Group</FieldLabel>
                        <Select
                          value={row.group_id || undefined}
                          onValueChange={(v) => field.onChange(updateScopeRow(scopes, index, { group_id: v ?? "" }))}
                          disabled={isSubmitting}
                        >
                          <SelectTrigger id={`scope-group-${index}`} className="w-full">
                            <SelectValue placeholder="Select group" />
                          </SelectTrigger>
                          <SelectContent>
                            {groupOptions.length === 0 ? (
                              <div className="px-1.5 py-1 text-xs text-muted-foreground">
                                Create a group first
                              </div>
                            ) : (
                              groupOptions.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                    {row.kind === "agent" && (
                      <Field className="min-w-36 flex-1">
                        <FieldLabel htmlFor={`scope-agent-${index}`}>Agent</FieldLabel>
                        <Select
                          value={row.agent_id || undefined}
                          onValueChange={(v) => field.onChange(updateScopeRow(scopes, index, { agent_id: v ?? "" }))}
                          disabled={isSubmitting}
                        >
                          <SelectTrigger id={`scope-agent-${index}`} className="w-full">
                            <SelectValue placeholder="Select agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {agentOptions.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(isSubmitting && "pointer-events-none opacity-50")}
                      disabled={scopes.length <= 1 || isSubmitting}
                      aria-label="Remove scope"
                      onClick={() => field.onChange(scopes.filter((_, i) => i !== index))}
                    >
                      <X />
                    </Button>
                  </div>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => field.onChange([...scopes, emptyScopeRow()])}
                >
                  Add scope
                </Button>
              </div>
            </div>
          );
        }}
      </FormField>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={onDismiss}>
          Cancel
        </Button>
        <Button type="submit" disabled={!patternFilled || isSubmitting}>
          {isSubmitting && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
