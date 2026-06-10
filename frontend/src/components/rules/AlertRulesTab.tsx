import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, ButtonDropdown, Checkbox, ColumnLayout, FormField, Header, Input, Modal, Pagination, SegmentedControl, Select, SpaceBetween, Table, Toggle, TextFilter, useCollection } from "../ui/console";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import type { Agent, AgentGroup, AlertRule, AlertRuleChannel, AlertRuleMatchMode, AlertRuleScopeKind } from "../../lib/types";
import { emptyScopeRow, formScopesToApi, scopeBadge, scopesToForm, type ScopeFormRow } from "./rulesUtils";
import { ScreenshotModal } from "./ScreenshotModal";

const CHANNEL_OPTIONS = [
  { label: "URL", value: "url" },
  { label: "URL category", value: "url_category" },
  { label: "Keystrokes", value: "keys" },
];
const MATCH_OPTIONS = [{ id: "substring", text: "Substring" }, { id: "regex", text: "Regex" }];
const SCOPE_OPTIONS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

interface AlertRuleForm {
  name: string;
  channel: AlertRuleChannel;
  pattern: string;
  match_mode: AlertRuleMatchMode;
  case_insensitive: boolean;
  cooldown_secs: number;
  enabled: boolean;
  take_screenshot: boolean;
  scopes: ScopeFormRow[];
}

function defaultForm(): AlertRuleForm {
  return { name: "", channel: "url", pattern: "", match_mode: "substring", case_insensitive: true, cooldown_secs: 300, enabled: true, take_screenshot: false, scopes: [emptyScopeRow()] };
}

interface AlertRuleHistoryRow {
  id: number;
  agent_id: string;
  agent_name: string;
  snippet: string;
  has_screenshot: boolean;
  created_at: string;
}

interface AlertRulesTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

export function AlertRulesTab({ groups, agents }: AlertRulesTabProps) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [ruleModal, setRuleModal] = useState<null | { mode: "create" } | { mode: "edit"; rule: AlertRule }>(null);
  const [ruleForm, setRuleForm] = useState<AlertRuleForm>(defaultForm());
  const [deleteRule, setDeleteRule] = useState<AlertRule | null>(null);
  const [historyRule, setHistoryRule] = useState<AlertRule | null>(null);
  const [historyEvents, setHistoryEvents] = useState<AlertRuleHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.alertRulesList();
      setRules(data.rules ?? []);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setRuleForm(defaultForm()); setRuleModal({ mode: "create" }); };
  const openEdit = (r: AlertRule) => { setRuleForm({ name: r.name, channel: r.channel, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, enabled: r.enabled, take_screenshot: Boolean(r.take_screenshot), scopes: scopesToForm(r.scopes ?? []) }); setRuleModal({ mode: "edit", rule: r }); };

  const saveRule = async () => {
    if (!ruleModal) return;
    const pattern = ruleForm.pattern.trim();
    if (!pattern) { setError("Pattern is required"); return; }
    setSaving(true); setError(null);
    try {
      const body = { name: ruleForm.name.trim(), channel: ruleForm.channel, pattern, match_mode: ruleForm.match_mode, case_insensitive: ruleForm.case_insensitive, cooldown_secs: ruleForm.cooldown_secs, enabled: ruleForm.enabled, take_screenshot: ruleForm.take_screenshot, scopes: formScopesToApi(ruleForm.scopes).map((s) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })) };
      if (ruleModal.mode === "create") await api.alertRulesCreate(body);
      else await api.alertRulesUpdate(ruleModal.rule.id, body);
      setRuleModal(null);
      await load();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  const openHistory = async (r: AlertRule) => {
    setHistoryRule(r);
    setHistoryLoading(true);
    try {
      const data = await api.alertRuleEvents(r.id, { limit: 200 });
      setHistoryEvents((data.rows ?? []).map((row: Record<string, unknown>) => ({
        id: Number(row.id), agent_id: String(row.agent_id ?? ""), agent_name: String(row.agent_name ?? ""),
        snippet: String(row.snippet ?? ""), has_screenshot: Boolean(row.has_screenshot), created_at: String(row.created_at ?? ""),
      })));
    } finally { setHistoryLoading(false); }
  };

  const { items: displayed, collectionProps, filterProps, paginationProps } = useCollection(rules, {
    filtering: { empty: "No rules", noMatch: "No matches", filteringFunction: (r, t) => r.name.toLowerCase().includes(t.toLowerCase()) || r.pattern.toLowerCase().includes(t.toLowerCase()) },
    pagination: { pageSize: 50 },
    sorting: {},
  });

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

  const updateScope = (i: number, patch: Partial<ScopeFormRow>) => {
    const scopes = [...ruleForm.scopes];
    const cur = { ...scopes[i], ...patch };
    if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
    if (patch.kind === "group") cur.agent_id = "";
    if (patch.kind === "agent") cur.group_id = "";
    scopes[i] = cur;
    setRuleForm({ ...ruleForm, scopes });
  };

  return (
    <>
      {error && <Box color="text-status-error" padding={{ bottom: "s" }}>{error}</Box>}

      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Loading…"
        items={displayed}
        variant="container"
        stickyHeader
        header={
          <Header counter={`(${rules.length})`} actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="primary" iconName="add-plus" onClick={openCreate}>New rule</Button>
            </SpaceBetween>
          }>Alert Rules</Header>
        }
        filter={<TextFilter {...filterProps} filteringPlaceholder="Search rules…" />}
        pagination={<Pagination {...paginationProps} />}
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No alert rules yet. Create one to start monitoring URLs or keystrokes.</Box>}
        columnDefinitions={[
          { id: "name", header: "Name", cell: (r) => r.name || <Box color="text-body-secondary">—</Box>, sortingField: "name", width: "20%" },
          { id: "channel", header: "Channel", cell: (r) => <Badge color={r.channel === "url" ? "blue" : "grey"}>{r.channel === "url" ? "URL" : "Keys"}</Badge>, width: 80 },
          { id: "pattern", header: "Pattern", cell: (r) => <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.pattern}</span></Box>, width: "25%" },
          { id: "scope", header: "Scope", cell: (r) => scopeBadge(r.scopes, groups, agentsById), width: "20%" },
          { id: "enabled", header: "Active", cell: (r) => <Toggle checked={r.enabled} onChange={() => { void api.alertRulesUpdate(r.id, { name: r.name, channel: r.channel, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, enabled: !r.enabled, take_screenshot: r.take_screenshot, scopes: (r.scopes ?? []).map((s: any) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })) }).then(load); }} />, width: 80 },
          {
            id: "actions",
            header: "Actions",
            width: 130,
            minWidth: 120,
            cell: (r) => (
              <ButtonDropdown
                expandToViewport
                items={[{ id: "history", text: "Event history" }, { id: "edit", text: "Edit" }, { id: "delete", text: "Delete" }]}
                onItemClick={({ detail }) => {
                  if (detail.id === "history") void openHistory(r);
                  if (detail.id === "edit") openEdit(r);
                  if (detail.id === "delete") setDeleteRule(r);
                }}
              >
                Actions
              </ButtonDropdown>
            ),
          },
        ]}
      />

      {/* Create/edit modal */}
      {ruleModal && (
        <Modal visible onDismiss={() => { setRuleModal(null); setError(null); }} size="large"
          header={ruleModal.mode === "create" ? "New alert rule" : "Edit alert rule"}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => { setRuleModal(null); setError(null); }}>Cancel</Button>
                <Button variant="primary" onClick={() => void saveRule()} loading={saving}>Save</Button>
              </SpaceBetween>
            </Box>
          }>
          <SpaceBetween size="m">
            {error && <Box color="text-status-error">{error}</Box>}
            <ColumnLayout columns={2}>
              <FormField label="Name (optional)">
                <Input value={ruleForm.name} onChange={({ detail }) => setRuleForm({ ...ruleForm, name: detail.value })} placeholder="e.g. YouTube block" />
              </FormField>
              <FormField label="Channel">
                <Select selectedOption={{ label: ruleForm.channel === "url" ? "URL" : ruleForm.channel === "url_category" ? "URL category" : "Keystrokes", value: ruleForm.channel }}
                  options={CHANNEL_OPTIONS}
                  onChange={({ detail }) => setRuleForm({ ...ruleForm, channel: detail.selectedOption.value as AlertRuleChannel })} />
              </FormField>
            </ColumnLayout>
            <FormField label="Pattern" description={ruleForm.match_mode === "regex" ? "ECMAScript regular expression." : "Case-insensitive substring to match against."}>
              <Input
                value={ruleForm.pattern}
                onChange={({ detail }) => setRuleForm({ ...ruleForm, pattern: detail.value })}
                placeholder={ruleForm.channel === "url" ? "e.g. youtube.com" : ruleForm.channel === "url_category" ? "e.g. adult" : "e.g. password"}
              />
            </FormField>
            <ColumnLayout columns={2}>
              <FormField label="Match mode">
                <SegmentedControl selectedId={ruleForm.match_mode} options={MATCH_OPTIONS}
                  onChange={({ detail }) => setRuleForm({ ...ruleForm, match_mode: detail.selectedId as AlertRuleMatchMode })} />
              </FormField>
              <FormField label="Cooldown (seconds)" description="Min seconds between repeated matches.">
                <Input type="number" value={String(ruleForm.cooldown_secs)}
                  onChange={({ detail }) => setRuleForm({ ...ruleForm, cooldown_secs: Math.max(0, parseInt(detail.value) || 0) })} />
              </FormField>
            </ColumnLayout>
            <SpaceBetween size="xs">
              <Checkbox checked={ruleForm.case_insensitive} onChange={({ detail }) => setRuleForm({ ...ruleForm, case_insensitive: detail.checked })}>Case insensitive</Checkbox>
              <Checkbox checked={ruleForm.take_screenshot} onChange={({ detail }) => setRuleForm({ ...ruleForm, take_screenshot: detail.checked })}>Take screenshot on trigger</Checkbox>
              <Checkbox checked={ruleForm.enabled} onChange={({ detail }) => setRuleForm({ ...ruleForm, enabled: detail.checked })}>Enabled</Checkbox>
            </SpaceBetween>
            <FormField label="Scope" description="Which agents this rule monitors.">
              <SpaceBetween size="xs">
                {ruleForm.scopes.map((s, i) => (
                  <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                    <div style={{ flex: "1 1 150px" }}>
                      <Select selectedOption={SCOPE_OPTIONS.find((o) => o.value === s.kind) ?? SCOPE_OPTIONS[0]}
                        options={SCOPE_OPTIONS}
                        onChange={({ detail }) => updateScope(i, { kind: detail.selectedOption.value as AlertRuleScopeKind })} />
                    </div>
                    {s.kind === "group" && (
                      <div style={{ flex: "1 1 150px" }}>
                        <Select placeholder="Select group" selectedOption={groupOptions.find((o) => o.value === s.group_id) ?? null}
                          options={groupOptions}
                          onChange={({ detail }) => updateScope(i, { group_id: detail.selectedOption.value })} />
                      </div>
                    )}
                    {s.kind === "agent" && (
                      <div style={{ flex: "1 1 150px" }}>
                        <Select placeholder="Select agent" selectedOption={agentOptions.find((o) => o.value === s.agent_id) ?? null}
                          options={agentOptions}
                          onChange={({ detail }) => updateScope(i, { agent_id: detail.selectedOption.value })} />
                      </div>
                    )}
                    {ruleForm.scopes.length > 1 && (
                      <Button variant="inline-icon" iconName="remove" onClick={() => {
                        const scopes = ruleForm.scopes.filter((_, j) => j !== i);
                        setRuleForm({ ...ruleForm, scopes });
                      }} />
                    )}
                  </div>
                ))}
                <Button variant="inline-link" iconName="add-plus" onClick={() => setRuleForm({ ...ruleForm, scopes: [...ruleForm.scopes, emptyScopeRow()] })}>
                  Add scope
                </Button>
              </SpaceBetween>
            </FormField>
          </SpaceBetween>
        </Modal>
      )}

      {/* Delete confirm */}
      <Modal visible={deleteRule != null} onDismiss={() => setDeleteRule(null)} header="Delete rule"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setDeleteRule(null)}>Cancel</Button>
              <Button variant="primary" onClick={async () => { if (!deleteRule) return; await api.alertRulesDelete(deleteRule.id); setDeleteRule(null); await load(); }}>Delete</Button>
            </SpaceBetween>
          </Box>
        }>
        Delete rule <strong>{deleteRule?.name || deleteRule?.pattern}</strong>? This cannot be undone.
      </Modal>

      {/* History modal */}
      {historyRule && (
        <Modal visible onDismiss={() => setHistoryRule(null)} size="large" header={`History — ${historyRule.name || historyRule.pattern}`}>
          <Table loading={historyLoading} loadingText="Loading…" items={historyEvents} variant="embedded"
            empty={<Box textAlign="center" padding="l" color="text-body-secondary">No events yet.</Box>}
            columnDefinitions={[
              { id: "time", header: "Time", cell: (r) => fmtDateTime(r.created_at), width: 170 },
              { id: "agent", header: "Agent", cell: (r) => r.agent_name, width: 180 },
              { id: "snippet", header: "Matched", cell: (r) => <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.snippet || "—"}</span></Box> },
              { id: "shot", header: "Screenshot", width: 110, cell: (r) => r.has_screenshot ? <Button variant="inline-link" iconName="zoom-to-fit" onClick={() => setPreviewEventId(r.id)}>View</Button> : <Box color="text-body-secondary" fontSize="body-s">—</Box> },
            ]} />
        </Modal>
      )}

      <ScreenshotModal eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </>
  );
}
