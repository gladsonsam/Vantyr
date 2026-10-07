import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  AlertRule,
  AlertRuleChannel,
  AlertRuleMatchMode,
  AlertRuleScopeKind,
} from "@/api/types";

interface RuleModalProps {
  visible: boolean;
  onDismiss: () => void;
  rule: AlertRule | null; // null for create
  /** Kept for compatibility; layout is responsive and ignores it. */
  isNarrow?: boolean;
  agentOptions: { label: string; value: string }[];
  groupOptions: { label: string; value: string }[];
  onSave: (data: {
    name: string;
    channel: AlertRuleChannel;
    pattern: string;
    match_mode: AlertRuleMatchMode;
    case_insensitive: boolean;
    cooldown_secs: number;
    enabled: boolean;
    take_screenshot: boolean;
    scopes: ScopeFormRow[];
  }) => Promise<void>;
}

type ScopeFormRow = {
  kind: AlertRuleScopeKind;
  group_id: string;
  agent_id: string;
};

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

function emptyScopeRow(): ScopeFormRow {
  return { kind: "all", group_id: "", agent_id: "" };
}

function CheckRow({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  );
}

export function RuleModal({
  visible,
  onDismiss,
  rule,
  agentOptions,
  groupOptions,
  onSave,
}: RuleModalProps) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<AlertRuleChannel>("url");
  const [pattern, setPattern] = useState("");
  const [matchMode, setMatchMode] = useState<AlertRuleMatchMode>("substring");
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [cooldownSecs, setCooldownSecs] = useState(300);
  const [enabled, setEnabled] = useState(true);
  const [takeScreenshot, setTakeScreenshot] = useState(false);
  const [scopes, setScopes] = useState<ScopeFormRow[]>([emptyScopeRow()]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (rule) {
      setName(rule.name);
      setChannel(rule.channel);
      setPattern(rule.pattern);
      setMatchMode(rule.match_mode);
      setCaseInsensitive(rule.case_insensitive);
      setCooldownSecs(rule.cooldown_secs);
      setEnabled(rule.enabled);
      setTakeScreenshot(Boolean(rule.take_screenshot));
      setScopes(
        rule.scopes.length === 0
          ? [emptyScopeRow()]
          : rule.scopes.map((s) => ({
              kind: s.kind,
              group_id: s.group_id ?? "",
              agent_id: s.agent_id ?? "",
            })),
      );
    } else {
      setName("");
      setChannel("url");
      setPattern("");
      setMatchMode("substring");
      setCaseInsensitive(true);
      setCooldownSecs(300);
      setEnabled(true);
      setTakeScreenshot(false);
      setScopes([emptyScopeRow()]);
    }
  }, [visible, rule]);

  const handleSave = async () => {
    if (!pattern.trim()) return;
    setLoading(true);
    try {
      await onSave({
        name: name.trim(),
        channel,
        pattern: pattern.trim(),
        match_mode: matchMode,
        case_insensitive: caseInsensitive,
        cooldown_secs: cooldownSecs,
        enabled,
        take_screenshot: takeScreenshot,
        scopes,
      });
      onDismiss();
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  const updateScopeRow = (index: number, patch: Partial<ScopeFormRow>) => {
    setScopes((prev) => {
      const next = [...prev];
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
    });
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !loading && onDismiss()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{rule ? "Edit alert rule" : "Create alert rule"}</DialogTitle>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="rule-name">Display name</FieldLabel>
            <Input
              id="rule-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={loading}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="rule-channel">Channel</FieldLabel>
              <Select
                value={channel}
                onValueChange={(v) => setChannel(v as AlertRuleChannel)}
                disabled={loading}
              >
                <SelectTrigger id="rule-channel" className="w-full">
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
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-match">Match mode</FieldLabel>
              <Select
                value={matchMode}
                onValueChange={(v) => setMatchMode(v as AlertRuleMatchMode)}
                disabled={loading}
              >
                <SelectTrigger id="rule-match" className="w-full">
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
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="rule-pattern">Pattern</FieldLabel>
            <Input
              id="rule-pattern"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              disabled={loading}
            />
            <FieldDescription>
              {matchMode === "regex"
                ? "Rust regex; case sensitivity follows the checkbox below."
                : "Substring match."}
            </FieldDescription>
          </Field>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <CheckRow
              checked={caseInsensitive}
              disabled={loading}
              onChange={setCaseInsensitive}
              label="Case-insensitive"
            />
            <CheckRow
              checked={takeScreenshot}
              disabled={loading}
              onChange={setTakeScreenshot}
              label="Take screenshot on trigger"
            />
            <CheckRow checked={enabled} disabled={loading} onChange={setEnabled} label="Enabled" />
          </div>

          <Field>
            <FieldLabel htmlFor="rule-cooldown">Cooldown (seconds)</FieldLabel>
            <Input
              id="rule-cooldown"
              type="number"
              min={0}
              value={String(cooldownSecs)}
              onChange={(event) => {
                const n = parseInt(event.target.value, 10);
                setCooldownSecs(Number.isFinite(n) ? Math.max(0, n) : 0);
              }}
              disabled={loading}
            />
            <FieldDescription>0 = fire every matching event (can be noisy).</FieldDescription>
          </Field>

          <div className="grid gap-2">
            <div className="text-sm font-medium">Scopes</div>
            {scopes.map((row, index) => (
              <div key={index} className="rounded-lg bg-muted/50 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <Field className="min-w-36 flex-1">
                    <FieldLabel htmlFor={`scope-kind-${index}`}>Applies to</FieldLabel>
                    <Select
                      value={row.kind}
                      onValueChange={(v) =>
                        updateScopeRow(index, { kind: v as AlertRuleScopeKind })
                      }
                      disabled={loading}
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
                        onValueChange={(v) => updateScopeRow(index, { group_id: v ?? "" })}
                        disabled={loading}
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
                        onValueChange={(v) => updateScopeRow(index, { agent_id: v ?? "" })}
                        disabled={loading}
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
                    className={cn(loading && "pointer-events-none opacity-50")}
                    disabled={scopes.length <= 1 || loading}
                    aria-label="Remove scope"
                    onClick={() => setScopes((prev) => prev.filter((_, i) => i !== index))}
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
                disabled={loading}
                onClick={() => setScopes((prev) => [...prev, emptyScopeRow()])}
              >
                Add scope
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={loading} onClick={onDismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={!pattern.trim() || loading}>
              {loading && <Spinner />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
