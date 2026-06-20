import { useState } from "react";
import { Modal, SpaceBetween, FormField, Input, Select, ColumnLayout, Checkbox, Box, Button, Header } from "../ui/console";
import type { AlertRule, AlertRuleChannel, AlertRuleMatchMode, AlertRuleScopeKind } from "../../lib/types";

export interface RuleModalProps {
  visible: boolean;
  onDismiss: () => void;
  rule: AlertRule | null; // null for create
  isNarrow: boolean;
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

const CHANNEL_OPTIONS = [
  { label: "URL", value: "url" },
  { label: "Keystrokes", value: "keys" },
];

const MATCH_OPTIONS = [
  { label: "Substring", value: "substring" },
  { label: "Regex", value: "regex" },
];

const SCOPE_KIND_OPTIONS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

function emptyScopeRow(): ScopeFormRow {
  return { kind: "all", group_id: "", agent_id: "" };
}

export function RuleModal({
  visible,
  onDismiss,
  rule,
  isNarrow,
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

  const [prevVisible, setPrevVisible] = useState(false);
  const [prevRule, setPrevRule] = useState<typeof rule | null>(null);

  if (visible !== prevVisible || rule !== prevRule) {
    setPrevVisible(visible);
    setPrevRule(rule);
    if (visible) {
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
              }))
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
    }
  }

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
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={rule ? "Edit alert rule" : "Create alert rule"}
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} loading={loading} disabled={!pattern.trim()}>
              Save
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label="Display name">
          <Input value={name} onChange={({ detail }) => setName(detail.value)} disabled={loading} />
        </FormField>
        <ColumnLayout columns={isNarrow ? 1 : 2}>
          <FormField label="Channel">
            <Select
              selectedOption={CHANNEL_OPTIONS.find((o) => o.value === channel)!}
              onChange={({ detail }) => {
                const v = detail.selectedOption?.value as AlertRuleChannel | undefined;
                if (v) setChannel(v);
              }}
              options={CHANNEL_OPTIONS}
              disabled={loading}
            />
          </FormField>
          <FormField label="Match mode">
            <Select
              selectedOption={MATCH_OPTIONS.find((o) => o.value === matchMode)!}
              onChange={({ detail }) => {
                const v = detail.selectedOption?.value as AlertRuleMatchMode | undefined;
                if (v) setMatchMode(v);
              }}
              options={MATCH_OPTIONS}
              disabled={loading}
            />
          </FormField>
        </ColumnLayout>
        <FormField
          label="Pattern"
          description={matchMode === "regex" ? "Rust regex; case sensitivity follows the checkbox below." : "Substring match."}
        >
          <Input value={pattern} onChange={({ detail }) => setPattern(detail.value)} disabled={loading} />
        </FormField>
        <div className="vantyr-notify-check-row">
          <SpaceBetween direction="horizontal" size="l">
            <Checkbox
              checked={caseInsensitive}
              onChange={({ detail }) => setCaseInsensitive(detail.checked)}
              disabled={loading}
            >
              Case-insensitive
            </Checkbox>
            <Checkbox
              checked={takeScreenshot}
              onChange={({ detail }) => setTakeScreenshot(detail.checked)}
              disabled={loading}
            >
              Take screenshot on trigger
            </Checkbox>
            <Checkbox checked={enabled} onChange={({ detail }) => setEnabled(detail.checked)} disabled={loading}>
              Enabled
            </Checkbox>
          </SpaceBetween>
        </div>
        <FormField label="Cooldown (seconds)" description="0 = fire every matching event (can be noisy).">
          <Input
            type="number"
            value={String(cooldownSecs)}
            onChange={({ detail }) => {
              const n = parseInt(detail.value, 10);
              setCooldownSecs(Number.isFinite(n) ? Math.max(0, n) : 0);
            }}
            disabled={loading}
          />
        </FormField>

        <Header variant="h3">Scopes</Header>
        {scopes.map((row, index) => (
          <Box key={index} padding="s" className="vantyr-notify-scope-row">
            <SpaceBetween size="s">
              <SpaceBetween direction="horizontal" size="xs" alignItems="start">
                <FormField label="Applies to">
                  <Select
                    selectedOption={SCOPE_KIND_OPTIONS.find((o) => o.value === row.kind)!}
                    onChange={({ detail }) => {
                      const v = detail.selectedOption?.value as AlertRuleScopeKind | undefined;
                      if (v) updateScopeRow(index, { kind: v });
                    }}
                    options={SCOPE_KIND_OPTIONS}
                    disabled={loading}
                  />
                </FormField>
                {row.kind === "group" && (
                  <FormField label="Group">
                    <Select
                      selectedOption={groupOptions.find((o) => o.value === row.group_id) ?? null}
                      onChange={({ detail }) => {
                        const v = detail.selectedOption?.value;
                        updateScopeRow(index, { group_id: typeof v === "string" ? v : "" });
                      }}
                      options={groupOptions}
                      placeholder="Select group"
                      empty="Create a group first"
                      disabled={loading}
                    />
                  </FormField>
                )}
                {row.kind === "agent" && (
                  <FormField label="Agent">
                    <Select
                      selectedOption={agentOptions.find((o) => o.value === row.agent_id) ?? null}
                      onChange={({ detail }) => {
                        const v = detail.selectedOption?.value;
                        updateScopeRow(index, { agent_id: typeof v === "string" ? v : "" });
                      }}
                      options={agentOptions}
                      placeholder="Select agent"
                      filteringType="auto"
                      disabled={loading}
                    />
                  </FormField>
                )}
                <div className="vantyr-notify-scope-remove">
                  <Button
                    disabled={scopes.length <= 1 || loading}
                    variant="icon"
                    iconName="remove"
                    ariaLabel="Remove scope"
                    onClick={() => setScopes((prev) => prev.filter((_, i) => i !== index))}
                  />
                </div>
              </SpaceBetween>
            </SpaceBetween>
          </Box>
        ))}
        <Button onClick={() => setScopes((prev) => [...prev, emptyScopeRow()])} disabled={loading}>
          Add scope
        </Button>
      </SpaceBetween>
    </Modal>
  );
}
