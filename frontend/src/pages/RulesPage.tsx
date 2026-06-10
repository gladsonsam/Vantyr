import { Badge, Box, Button, ButtonDropdown, Checkbox, ColumnLayout, ContentLayout, FormField, Header, Input, Modal, Pagination, SegmentedControl, Select, SpaceBetween, Table, Tabs, TextFilter, Toggle, useCollection } from "../components/ui/console";
/**
 * Rules — unified management hub for all rule types.
 *
 * Tab 1 · Alert Rules    — URL / keystroke match rules (moved from /notifications)
 * Tab 2 · App Blocking   — kill-process rules
 * Tab 3 · Events         — cross-agent feed of alert matches + app block kills
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, apiUrl } from "../lib/api";
import { fmtDateTime } from "../lib/utils";
import { AppIcon } from "../components/common/AppIcon";
import type {
  Agent,
  AgentGroup,
  AlertRule,
  AlertRuleChannel,
  AlertRuleMatchMode,
  AlertRuleScopeKind,
  AlertRuleScope,
  AppBlockRule,
  AppBlockRuleScope,
  AppBlockEvent,
  InternetBlockRule,
} from "../lib/types";

// ── Shared helpers ────────────────────────────────────────────────────────────

type ScopeFormRow = { kind: AlertRuleScopeKind; group_id: string; agent_id: string };

function emptyScopeRow(): ScopeFormRow { return { kind: "all", group_id: "", agent_id: "" }; }

function scopesToForm(scopes: AlertRuleScope[]): ScopeFormRow[] {
  if (!scopes || scopes.length === 0) return [emptyScopeRow()];
  return scopes.map((s) => ({ kind: s.kind, group_id: s.group_id ?? "", agent_id: s.agent_id ?? "" }));
}

function formScopesToApi(rows: ScopeFormRow[]): AlertRuleScope[] {
  return rows.map((r) => {
    if (r.kind === "all") return { kind: "all" };
    if (r.kind === "group") return { kind: "group", group_id: r.group_id };
    return { kind: "agent", agent_id: r.agent_id };
  });
}

function scopeBadge(scopes?: AlertRuleScope[], groups?: AgentGroup[], agentsById?: Record<string, Agent>) {
  if (!scopes || scopes.length === 0) return <Badge color="grey">—</Badge>;
  const s = scopes[0];
  if (s.kind === "all") return <Badge color="red">All devices</Badge>;
  if (s.kind === "group") {
    const g = groups?.find((x) => x.id === s.group_id);
    return <Badge color="severity-medium">Group: {g?.name ?? s.group_id ?? "?"}</Badge>;
  }
  const a = s.agent_id ? agentsById?.[s.agent_id] : undefined;
  return <Badge color="blue">Agent: {a?.name ?? s.agent_id ?? "?"}</Badge>;
}

function appBlockScopeBadge(rule: AppBlockRule, groups?: AgentGroup[], agentsById?: Record<string, Agent>) {
  if (!rule.scopes || rule.scopes.length === 0) {
    const kind = rule.scope_kind ?? "agent";
    if (kind === "all") return <Badge color="red">All devices</Badge>;
    if (kind === "group") return <Badge color="severity-medium">Group</Badge>;
    return <Badge color="blue">This device</Badge>;
  }
  return scopeBadge(rule.scopes as unknown as AlertRuleScope[], groups, agentsById);
}

// ── Screenshot preview ────────────────────────────────────────────────────────

function ScreenshotModal({ eventId, onClose }: { eventId: number | null; onClose: () => void }) {
  return (
    <Modal visible={eventId != null} onDismiss={onClose} header="Screenshot" size="max"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {eventId != null && <Button href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} target="_blank" iconName="external">Open</Button>}
            <Button variant="link" onClick={onClose}>Close</Button>
          </SpaceBetween>
        </Box>
      }>
      {eventId != null && (
        <div style={{ textAlign: "center" }}>
          <img src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} alt="screenshot"
            style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 6 }} />
        </div>
      )}
    </Modal>
  );
}

// ── Alert rule create/edit modal ──────────────────────────────────────────────

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

function AlertRuleFormModal({
  mode,
  form,
  groups,
  agents,
  error,
  onFormChange,
  onSave,
  onCancel,
  saving,
}: {
  mode: "create" | "edit";
  form: AlertRuleForm;
  groups: AgentGroup[];
  agents: Agent[];
  error: string | null;
  onFormChange: (f: AlertRuleForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

  const updateScope = (i: number, patch: Partial<ScopeFormRow>) => {
    const scopes = [...form.scopes];
    const cur = { ...scopes[i], ...patch };
    if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
    if (patch.kind === "group") cur.agent_id = "";
    if (patch.kind === "agent") cur.group_id = "";
    scopes[i] = cur;
    onFormChange({ ...form, scopes });
  };

  return (
    <Modal visible onDismiss={onCancel} size="large"
      header={mode === "create" ? "New alert rule" : "Edit alert rule"}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={onSave} loading={saving}>Save</Button>
          </SpaceBetween>
        </Box>
      }>
      <SpaceBetween size="m">
        {error && <Box color="text-status-error">{error}</Box>}
        <ColumnLayout columns={2}>
          <FormField label="Name (optional)">
            <Input value={form.name} onChange={({ detail }) => onFormChange({ ...form, name: detail.value })} placeholder="e.g. YouTube block" />
          </FormField>
          <FormField label="Channel">
            <Select selectedOption={{ label: form.channel === "url" ? "URL" : form.channel === "url_category" ? "URL category" : "Keystrokes", value: form.channel }}
              options={CHANNEL_OPTIONS}
              onChange={({ detail }) => onFormChange({ ...form, channel: detail.selectedOption.value as AlertRuleChannel })} />
          </FormField>
        </ColumnLayout>
        <FormField label="Pattern" description={form.match_mode === "regex" ? "ECMAScript regular expression." : "Case-insensitive substring to match against."}>
          <Input
            value={form.pattern}
            onChange={({ detail }) => onFormChange({ ...form, pattern: detail.value })}
            placeholder={form.channel === "url" ? "e.g. youtube.com" : form.channel === "url_category" ? "e.g. adult" : "e.g. password"}
          />
        </FormField>
        <ColumnLayout columns={2}>
          <FormField label="Match mode">
            <SegmentedControl selectedId={form.match_mode} options={MATCH_OPTIONS}
              onChange={({ detail }) => onFormChange({ ...form, match_mode: detail.selectedId as AlertRuleMatchMode })} />
          </FormField>
          <FormField label="Cooldown (seconds)" description="Min seconds between repeated matches.">
            <Input type="number" value={String(form.cooldown_secs)}
              onChange={({ detail }) => onFormChange({ ...form, cooldown_secs: Math.max(0, parseInt(detail.value) || 0) })} />
          </FormField>
        </ColumnLayout>
        <SpaceBetween size="xs">
          <Checkbox checked={form.case_insensitive} onChange={({ detail }) => onFormChange({ ...form, case_insensitive: detail.checked })}>Case insensitive</Checkbox>
          <Checkbox checked={form.take_screenshot} onChange={({ detail }) => onFormChange({ ...form, take_screenshot: detail.checked })}>Take screenshot on trigger</Checkbox>
          <Checkbox checked={form.enabled} onChange={({ detail }) => onFormChange({ ...form, enabled: detail.checked })}>Enabled</Checkbox>
        </SpaceBetween>
        <FormField label="Scope" description="Which agents this rule monitors.">
          <SpaceBetween size="xs">
            {form.scopes.map((s, i) => (
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
                {form.scopes.length > 1 && (
                  <Button variant="inline-icon" iconName="remove" onClick={() => {
                    const scopes = form.scopes.filter((_, j) => j !== i);
                    onFormChange({ ...form, scopes });
                  }} />
                )}
              </div>
            ))}
            <Button variant="inline-link" iconName="add-plus" onClick={() => onFormChange({ ...form, scopes: [...form.scopes, emptyScopeRow()] })}>
              Add scope
            </Button>
          </SpaceBetween>
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

// ── Alert Rules tab ───────────────────────────────────────────────────────────

interface AlertRuleHistoryRow {
  id: number;
  agent_id: string;
  agent_name: string;
  snippet: string;
  has_screenshot: boolean;
  created_at: string;
}

function AlertRulesTab({ groups, agents }: { groups: AgentGroup[]; agents: Agent[] }) {
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
        <AlertRuleFormModal mode={ruleModal.mode} form={ruleForm} groups={groups} agents={agents} error={error} saving={saving}
          onFormChange={setRuleForm} onSave={() => void saveRule()} onCancel={() => { setRuleModal(null); setError(null); }} />
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

// ── App Blocking tab ──────────────────────────────────────────────────────────

function AppBlockingTab({ groups, agents }: { groups: AgentGroup[]; agents: Agent[] }) {
  const [rules, setRules] = useState<AppBlockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editRule, setEditRule] = useState<AppBlockRule | null>(null);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editSaving, setEditSaving] = useState(false);
  const [editExePattern, setEditExePattern] = useState("");
  const [editMatchMode, setEditMatchMode] = useState<"contains" | "exact">("contains");
  const [editLabel, setEditLabel] = useState("");
  const [editScopes, setEditScopes] = useState<ScopeFormRow[]>([emptyScopeRow()]);
  const [editScheduled, setEditScheduled] = useState(false);
  const [editScheduleRows, setEditScheduleRows] = useState<Array<{ day_of_week: number; start: string; end: string }>>([
    { day_of_week: 1, start: "00:00", end: "23:59" },
  ]);
  const [historyRule, setHistoryRule] = useState<AppBlockRule | null>(null);
  const [historyEvents, setHistoryEvents] = useState<AppBlockEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.appBlockRulesList();
      setRules(data.rules ?? []);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openHistory = async (r: AppBlockRule) => {
    setHistoryRule(r);
    setHistoryLoading(true);
    try {
      const data = await api.appBlockEventsForRule(r.id, { limit: 200 });
      setHistoryEvents(data.rows);
    } catch { setHistoryEvents([]); }
    finally { setHistoryLoading(false); }
  };

  const toggleRule = (r: AppBlockRule) => {
    setTogglingId(r.id);
    api.appBlockRulesUpdate(r.id, { enabled: !r.enabled })
      .then(() => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
      .catch((e) => setError(String(e)))
      .finally(() => setTogglingId(null));
  };

  const deleteRule = async (r: AppBlockRule) => {
    if (!confirm(`Delete block rule "${r.name || r.exe_pattern}"?`)) return;
    try { await api.appBlockRulesDelete(r.id); setRules((prev) => prev.filter((x) => x.id !== r.id)); }
    catch (e) { setError(String(e)); }
  };

  const { items: displayed, collectionProps, filterProps, paginationProps } = useCollection(rules, {
    filtering: { empty: "No rules", noMatch: "No matches", filteringFunction: (r, t) => r.exe_pattern.toLowerCase().includes(t.toLowerCase()) || (r.name || "").toLowerCase().includes(t.toLowerCase()) },
    pagination: { pageSize: 50 },
    sorting: {},
  });

  const contextAgentId = agents[0]?.id ?? "";

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);
  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));
  const SCOPE_OPTIONS = [{ label: "All agents", value: "all" }, { label: "Agent group", value: "group" }, { label: "Single agent", value: "agent" }];

  const updateScope = (i: number, patch: Partial<ScopeFormRow>) => {
    setEditScopes((prev) => {
      const next = [...prev];
      const cur = { ...next[i], ...patch };
      if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
      if (patch.kind === "group") cur.agent_id = "";
      if (patch.kind === "agent") cur.group_id = "";
      next[i] = cur;
      return next;
    });
  };

  const DAY_OPTIONS = [
    { label: "Sunday", value: "0" },
    { label: "Monday", value: "1" },
    { label: "Tuesday", value: "2" },
    { label: "Wednesday", value: "3" },
    { label: "Thursday", value: "4" },
    { label: "Friday", value: "5" },
    { label: "Saturday", value: "6" },
  ];

  const timeToMinute = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    const hhRaw = parseInt(m[1], 10);
    const mmRaw = parseInt(m[2], 10);
    const mm = Math.max(0, Math.min(59, mmRaw));
    if (hhRaw === 24 && mm === 0) return 1440;
    const hh = Math.max(0, Math.min(23, hhRaw));
    return hh * 60 + mm;
  };

  const minuteToTime = (min: number): string => {
    const m = Math.max(0, Math.min(1440, Math.floor(min)));
    if (m === 1440) return "24:00";
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const expandScheduleRows = (rows: Array<{ day_of_week: number; start: string; end: string }>) => {
    const out: { day_of_week: number; start_minute: number; end_minute: number }[] = [];
    for (const r of rows) {
      const s = timeToMinute(r.start);
      const e = timeToMinute(r.end);
      if (s == null || e == null) continue;
      if (s === e) continue;
      if (s < e) {
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: e });
      } else {
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: 1440 });
        out.push({ day_of_week: (r.day_of_week + 1) % 7, start_minute: 0, end_minute: e });
      }
    }
    return out;
  };

  const scheduleSummary = (schedules: { day_of_week: number; start_minute: number; end_minute: number }[]) => {
    if (!schedules || schedules.length === 0) return <Box color="text-body-secondary">Always</Box>;
    const day = (d: number) => DAY_OPTIONS.find((o) => o.value === String(d))?.label?.slice(0, 3) ?? "?";
    const parts = schedules.slice(0, 2).map((w) => `${day(w.day_of_week)} ${minuteToTime(w.start_minute)}–${minuteToTime(w.end_minute)}`);
    const more = schedules.length > 2 ? ` +${schedules.length - 2}` : "";
    return <span>{parts.join(", ")}{more}</span>;
  };

  const openCreate = () => {
    setModalMode("create");
    setEditRule(null);
    setEditExePattern("");
    setEditMatchMode("contains");
    setEditLabel("");
    setEditScopes([{ kind: "all", group_id: "", agent_id: "" }]);
    setEditScheduled(false);
    setEditScheduleRows([{ day_of_week: 1, start: "00:00", end: "23:59" }]);
    setShowModal(true);
  };

  const openEdit = (r: AppBlockRule) => {
    setModalMode("edit");
    setEditRule(r);
    setEditExePattern(r.exe_pattern);
    setEditMatchMode(r.match_mode);
    setEditLabel(r.name || "");
    const scopes = r.scopes && r.scopes.length > 0 ? r.scopes : [{ kind: r.scope_kind ?? "agent", group_id: "", agent_id: contextAgentId }];
    setEditScopes(scopesToForm(scopes as unknown as AlertRuleScope[]));
    const sched = Array.isArray(r.schedules) ? r.schedules : [];
    setEditScheduled(sched.length > 0);
    setEditScheduleRows(
      sched.length > 0
        ? sched.map((w) => ({
          day_of_week: w.day_of_week,
          start: minuteToTime(w.start_minute),
          end: minuteToTime(w.end_minute),
        }))
        : [{ day_of_week: 1, start: "00:00", end: "23:59" }],
    );
    setShowModal(true);
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
          }>App Blocking</Header>
        }
        filter={<TextFilter {...filterProps} filteringPlaceholder="Search rules…" />}
        pagination={<Pagination {...paginationProps} />}
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No app block rules yet.</Box>}
        columnDefinitions={[
          {
            id: "exe", header: "EXE name",
            cell: (r) => (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {contextAgentId && <AppIcon agentId={contextAgentId} exeName={r.exe_pattern} size={18} />}
                <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.exe_pattern}</span></Box>
                <Badge color="grey">{r.match_mode}</Badge>
              </div>
            ),
            width: "35%",
          },
          { id: "name", header: "Label", cell: (r) => r.name || <Box color="text-body-secondary">—</Box>, width: "20%" },
          { id: "scope", header: "Scope", cell: (r) => appBlockScopeBadge(r, groups, agentsById), width: 150 },
          { id: "schedule", header: "Schedule", cell: (r) => scheduleSummary(r.schedules), width: 220 },
          { id: "enabled", header: "Active", cell: (r) => <Toggle checked={r.enabled} disabled={togglingId === r.id} onChange={() => toggleRule(r)} />, width: 80 },
          {
            id: "actions",
            header: "Actions",
            width: 130,
            minWidth: 120,
            cell: (r) => (
              <ButtonDropdown
                expandToViewport
                items={[
                  { id: "edit", text: "Edit" },
                  { id: "history", text: "Kill history" },
                  { id: "delete", text: "Delete" },
                ]}
                onItemClick={({ detail }) => {
                  if (detail.id === "edit") openEdit(r);
                  if (detail.id === "history") void openHistory(r);
                  if (detail.id === "delete") void deleteRule(r);
                }}
              >
                Actions
              </ButtonDropdown>
            ),
          },
        ]}
      />

      {/* Create / Edit modal */}
      <Modal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        header={modalMode === "create" ? "Add app block rule" : `Edit app block rule — ${editRule?.name || editRule?.exe_pattern || ""}`}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowModal(false)} disabled={editSaving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={editSaving}
                onClick={() => {
                  const pattern = editExePattern.trim();
                  if (!pattern) {
                    setError("EXE name is required.");
                    return;
                  }
                  setEditSaving(true);
                  const scopes = formScopesToApi(editScopes) as unknown as AppBlockRuleScope[];
                  const schedules = editScheduled ? expandScheduleRows(editScheduleRows) : [];

                  const body = {
                    name: editLabel.trim() || pattern,
                    exe_pattern: pattern,
                    match_mode: editMatchMode,
                    scopes,
                    schedules,
                  };

                  const p = modalMode === "create"
                    ? api.appBlockRulesCreate(body)
                    : api.appBlockRulesUpdate(editRule!.id, body);

                  p.then(() => load())
                    .then(() => setShowModal(false))
                    .catch((e) => setError(String(e)))
                    .finally(() => setEditSaving(false));
                }}
              >
                {modalMode === "create" ? "Add rule" : "Save"}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {error && <Box color="text-status-error">{error}</Box>}
          <FormField label="EXE name" description="Executable file name to block (e.g. tiktok.exe).">
            <Input value={editExePattern} onChange={({ detail }) => setEditExePattern(detail.value)} />
          </FormField>
          <FormField label="Match mode">
            <SegmentedControl
              selectedId={editMatchMode}
              onChange={({ detail }) => setEditMatchMode(detail.selectedId as "contains" | "exact")}
              options={[
                { id: "contains", text: "Contains" },
                { id: "exact", text: "Exact" },
              ]}
            />
          </FormField>
          <FormField label="Label">
            <Input value={editLabel} onChange={({ detail }) => setEditLabel(detail.value)} placeholder="Optional" />
          </FormField>
          <FormField label="Scope" description="Which agents this rule applies to.">
            <SpaceBetween size="xs">
              {editScopes.map((s, i) => (
                <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                  <div style={{ flex: "1 1 150px" }}>
                    <Select selectedOption={SCOPE_OPTIONS.find((o) => o.value === s.kind) ?? SCOPE_OPTIONS[0]}
                      options={SCOPE_OPTIONS}
                      onChange={({ detail }) => updateScope(i, { kind: detail.selectedOption.value as ScopeFormRow["kind"] })} />
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
                  {editScopes.length > 1 && (
                    <Button variant="inline-icon" iconName="remove" onClick={() => setEditScopes((p) => p.filter((_, j) => j !== i))} />
                  )}
                </div>
              ))}
              <Button variant="inline-link" iconName="add-plus" onClick={() => setEditScopes((p) => [...p, emptyScopeRow()])}>Add scope</Button>
            </SpaceBetween>
          </FormField>

          <FormField
            label="Schedule (optional)"
            description="If enabled, this rule only applies during these windows in the agent's local time. Overnight windows are supported (e.g. 22:00 → 06:00)."
          >
            <SpaceBetween size="xs">
              <Checkbox checked={editScheduled} onChange={({ detail }) => setEditScheduled(detail.checked)}>
                Enable schedule (curfew)
              </Checkbox>
              {editScheduled ? (
                <SpaceBetween size="xs">
                  {editScheduleRows.map((r, i) => (
                    <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                      <div style={{ flex: "1 1 120px" }}>
                        <Select
                          selectedOption={DAY_OPTIONS.find((o) => o.value === String(r.day_of_week)) ?? DAY_OPTIONS[1]}
                          options={DAY_OPTIONS}
                          onChange={({ detail }) =>
                            setEditScheduleRows((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], day_of_week: Number(detail.selectedOption.value) };
                              return next;
                            })
                          }
                        />
                      </div>
                      <div style={{ width: "100px" }}>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={r.start}
                          onChange={({ detail }) =>
                            setEditScheduleRows((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], start: detail.value };
                              return next;
                            })
                          }
                          placeholder="HH:MM"
                        />
                      </div>
                      <Box>to</Box>
                      <div style={{ width: "100px" }}>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={r.end}
                          onChange={({ detail }) =>
                            setEditScheduleRows((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], end: detail.value };
                              return next;
                            })
                          }
                          placeholder="HH:MM"
                        />
                      </div>
                      <Button
                        variant="inline-icon"
                        iconName="remove"
                        ariaLabel="Remove window"
                        disabled={editScheduleRows.length <= 1}
                        onClick={() => setEditScheduleRows((prev) => prev.filter((_, idx) => idx !== i))}
                      />
                    </div>
                  ))}
                  <Button
                    iconName="add-plus"
                    onClick={() =>
                      setEditScheduleRows((prev) => [
                        ...prev,
                        { day_of_week: 1, start: "00:00", end: "23:59" },
                      ])
                    }
                  >
                    Add window
                  </Button>
                </SpaceBetween>
              ) : null}
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Modal>



      {/* History modal */}
      {historyRule && (
        <Modal visible onDismiss={() => setHistoryRule(null)} size="large" header={`Kill history — ${historyRule.name || historyRule.exe_pattern}`}>
          <Table loading={historyLoading} loadingText="Loading…" items={historyEvents} variant="embedded"
            empty={<Box textAlign="center" padding="l" color="text-body-secondary">No kills recorded yet.</Box>}
            columnDefinitions={[
              { id: "time", header: "Time", cell: (r) => fmtDateTime(r.killed_at), width: 170 },
              { id: "agent", header: "Agent", cell: (r) => r.agent_name, width: 180 },
              { id: "exe", header: "EXE", cell: (r) => <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.exe_name}</span></Box> },
            ]} />
        </Modal>
      )}
    </>
  );
}

// ── Events tab ────────────────────────────────────────────────────────────────

type EventFilter = "all" | "alerts" | "appblock" | "scripts" | "connections";

interface UnifiedEvent {
  id: string;
  type: "alert" | "appblock" | "script" | "connection";
  agent_id: string;
  agent_name: string;
  rule_name: string;
  detail: string;
  time: string;
  status?: string;
  screenshot_id?: number;
  has_screenshot?: boolean;
}

// ── Internet Access tab ───────────────────────────────────────────────────────

type InetScopeFormRow = { kind: "all" | "group" | "agent"; group_id: string; agent_id: string };
type InetScheduleFormRow = { day_of_week: number; start: string; end: string };

function emptyInetScope(): InetScopeFormRow { return { kind: "all", group_id: "", agent_id: "" }; }
function emptyInetSchedule(): InetScheduleFormRow { return { day_of_week: 1, start: "00:00", end: "23:59" }; }

function InternetAccessTab({ groups, agents }: { groups: AgentGroup[]; agents: Agent[] }) {
  const [rules, setRules] = useState<InternetBlockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScopes, setCreateScopes] = useState<InetScopeFormRow[]>([emptyInetScope()]);
  const [createScheduled, setCreateScheduled] = useState(false);
  const [createSchedules, setCreateSchedules] = useState<InetScheduleFormRow[]>([emptyInetSchedule()]);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [editScheduleFor, setEditScheduleFor] = useState<InternetBlockRule | null>(null);
  const [editSchedules, setEditSchedules] = useState<InetScheduleFormRow[]>([emptyInetSchedule()]);
  const [editSaving, setEditSaving] = useState(false);

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));
  const DAY_OPTIONS = [
    { label: "Sunday", value: "0" },
    { label: "Monday", value: "1" },
    { label: "Tuesday", value: "2" },
    { label: "Wednesday", value: "3" },
    { label: "Thursday", value: "4" },
    { label: "Friday", value: "5" },
    { label: "Saturday", value: "6" },
  ];

  const timeToMinute = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    const hhRaw = parseInt(m[1], 10);
    const mmRaw = parseInt(m[2], 10);
    const mm = Math.max(0, Math.min(59, mmRaw));
    // Allow 24:00 as an alias for "end of day" (1440).
    if (hhRaw === 24 && mm === 0) return 1440;
    const hh = Math.max(0, Math.min(23, hhRaw));
    return hh * 60 + mm;
  };

  const expandScheduleRows = (rows: InetScheduleFormRow[]) => {
    const out: { day_of_week: number; start_minute: number; end_minute: number }[] = [];
    for (const r of rows) {
      const s = timeToMinute(r.start);
      const e = timeToMinute(r.end);
      if (s == null || e == null) continue;
      if (s === e) continue;
      if (s < e) {
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: e });
      } else {
        // Overnight: split across two days.
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: 1440 });
        out.push({ day_of_week: (r.day_of_week + 1) % 7, start_minute: 0, end_minute: e });
      }
    }
    return out;
  };

  const minuteToTime = (min: number): string => {
    const m = Math.max(0, Math.min(1440, Math.floor(min)));
    if (m === 1440) return "24:00";
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const scheduleSummary = (schedules: { day_of_week: number; start_minute: number; end_minute: number }[]) => {
    if (!schedules || schedules.length === 0) return <Box color="text-body-secondary">Always</Box>;
    const day = (d: number) => DAY_OPTIONS.find((o) => o.value === String(d))?.label?.slice(0, 3) ?? "?";
    const parts = schedules.slice(0, 2).map((w) => `${day(w.day_of_week)} ${minuteToTime(w.start_minute)}–${minuteToTime(w.end_minute)}`);
    const more = schedules.length > 2 ? ` +${schedules.length - 2}` : "";
    return <span>{parts.join(", ")}{more}</span>;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.internetBlockRulesList(); setRules(d.rules ?? []); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const inetScopeBadge = (r: InternetBlockRule) => {
    const s = r.scopes[0];
    if (!s) return <Badge color="grey">—</Badge>;
    if (s.kind === "all") return <Badge color="red">All devices</Badge>;
    if (s.kind === "group") {
      const g = groups.find((x) => x.id === s.group_id);
      return <Badge color="severity-medium">Group: {g?.name ?? "?"}</Badge>;
    }
    const a = agents.find((x) => x.id === s.agent_id);
    return <Badge color="blue">Agent: {a?.name ?? "?"}</Badge>;
  };

  const updateScope = (i: number, patch: Partial<InetScopeFormRow>) => {
    setCreateScopes((prev) => {
      const next = [...prev];
      const cur = { ...next[i], ...patch };
      if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
      if (patch.kind === "group") cur.agent_id = "";
      if (patch.kind === "agent") cur.group_id = "";
      next[i] = cur;
      return next;
    });
  };

  const createRule = async () => {
    setSaving(true); setError(null);
    try {
      const schedules = createScheduled ? expandScheduleRows(createSchedules) : undefined;
      if (createScheduled && (!schedules || schedules.length === 0)) {
        throw new Error("Schedule is enabled but no valid windows were provided (use HH:MM).");
      }
      await api.internetBlockRulesCreate({
        name: createName.trim(),
        scopes: createScopes.map((s) => ({ kind: s.kind, group_id: s.group_id || undefined, agent_id: s.agent_id || undefined })),
        schedules,
      });
      setShowCreate(false);
      setCreateName("");
      setCreateScopes([emptyInetScope()]);
      setCreateScheduled(false);
      setCreateSchedules([emptyInetSchedule()]);
      await load();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  const toggleRule = (r: InternetBlockRule) => {
    setTogglingId(r.id);
    api.internetBlockRulesUpdate(r.id, { enabled: !r.enabled })
      .then(() => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
      .catch((e) => setError(String(e)))
      .finally(() => setTogglingId(null));
  };

  const deleteRule = async (r: InternetBlockRule) => {
    if (!confirm(`Delete rule "${r.name || "Internet block"}"?`)) return;
    try { await api.internetBlockRulesDelete(r.id); setRules((prev) => prev.filter((x) => x.id !== r.id)); }
    catch (e) { setError(String(e)); }
  };

  const SCOPE_OPTS = [{ label: "All agents", value: "all" }, { label: "Agent group", value: "group" }, { label: "Single agent", value: "agent" }];

  return (
    <>
      {error && <Box color="text-status-error" padding={{ bottom: "s" }}>{error}</Box>}

      <Table
        loading={loading}
        loadingText="Loading…"
        items={rules}
        variant="container"
        stickyHeader
        header={
          <Header counter={`(${rules.length})`} actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="primary" iconName="add-plus" onClick={() => setShowCreate(true)}>New rule</Button>
            </SpaceBetween>
          }>Internet Access</Header>
        }
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No internet block rules. Create one to restrict internet access for all devices, a group, or a specific device.</Box>}
        columnDefinitions={[
          { id: "name", header: "Name", cell: (r) => r.name || <Box color="text-body-secondary">Unnamed</Box>, width: "30%" },
          { id: "scope", header: "Scope", cell: (r) => inetScopeBadge(r), width: "25%" },
          { id: "schedule", header: "Schedule", cell: (r) => scheduleSummary(r.schedules), width: "25%" },
          { id: "enabled", header: "Active", cell: (r) => <Toggle checked={r.enabled} disabled={togglingId === r.id} onChange={() => toggleRule(r)} />, width: 80 },
          { id: "created", header: "Created", cell: (r) => fmtDateTime(r.created_at), width: 170 },
          {
            id: "actions",
            header: "Actions",
            width: 130,
            minWidth: 120,
            cell: (r) => (
              <ButtonDropdown
                expandToViewport
                items={[
                  { id: "edit_schedule", text: "Edit schedule" },
                  { id: "delete", text: "Delete" },
                ]}
                onItemClick={({ detail }) => {
                  if (detail.id === "delete") void deleteRule(r);
                  if (detail.id === "edit_schedule") {
                    setEditScheduleFor(r);
                    const rows: InetScheduleFormRow[] = (r.schedules ?? []).length
                      ? (r.schedules ?? []).map((w: any) => ({ day_of_week: w.day_of_week, start: minuteToTime(w.start_minute), end: minuteToTime(w.end_minute) }))
                      : [emptyInetSchedule()];
                    setEditSchedules(rows);
                  }
                }}
              >
                Actions
              </ButtonDropdown>
            ),
          },
        ]}
      />

      {/* Create modal */}
      <Modal visible={showCreate} onDismiss={() => setShowCreate(false)} header="New internet block rule"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void createRule()} loading={saving}>Create</Button>
            </SpaceBetween>
          </Box>
        }>
        <SpaceBetween size="m">
          {error && <Box color="text-status-error">{error}</Box>}
          <FormField label="Name (optional)">
            <Input value={createName} onChange={({ detail }) => setCreateName(detail.value)} placeholder="e.g. Block school devices" />
          </FormField>
          <FormField label="Scope" description="Who this rule blocks.">
            <SpaceBetween size="xs">
              {createScopes.map((s, i) => (
                <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                  <Select selectedOption={SCOPE_OPTS.find((o) => o.value === s.kind) ?? SCOPE_OPTS[0]}
                    options={SCOPE_OPTS}
                    onChange={({ detail }) => updateScope(i, { kind: detail.selectedOption.value as InetScopeFormRow["kind"] })} />
                  {s.kind === "group" && (
                    <Select placeholder="Select group" selectedOption={groupOptions.find((o) => o.value === s.group_id) ?? null}
                      options={groupOptions}
                      onChange={({ detail }) => updateScope(i, { group_id: detail.selectedOption.value })} />
                  )}
                  {s.kind === "agent" && (
                    <Select placeholder="Select agent" selectedOption={agentOptions.find((o) => o.value === s.agent_id) ?? null}
                      options={agentOptions}
                      onChange={({ detail }) => updateScope(i, { agent_id: detail.selectedOption.value })} />
                  )}
                  {createScopes.length > 1 && (
                    <Button variant="inline-icon" iconName="remove" onClick={() => setCreateScopes((p) => p.filter((_, j) => j !== i))} />
                  )}
                </div>
              ))}
              <Button variant="inline-link" iconName="add-plus" onClick={() => setCreateScopes((p) => [...p, emptyInetScope()])}>Add scope</Button>
            </SpaceBetween>
          </FormField>

          <FormField label="Schedule (optional)" description="If enabled, this rule only applies during these windows in the agent's local time.">
            <SpaceBetween size="xs">
              <Checkbox checked={createScheduled} onChange={({ detail }) => setCreateScheduled(detail.checked)}>
                Enable schedule (curfew)
              </Checkbox>
              {createScheduled ? (
                <SpaceBetween size="xs">
                  {createSchedules.map((r, i) => (
                    <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                      <div style={{ flex: "1 1 120px" }}>
                        <Select
                          selectedOption={DAY_OPTIONS.find((o) => o.value === String(r.day_of_week)) ?? DAY_OPTIONS[1]}
                          options={DAY_OPTIONS}
                          onChange={({ detail }) =>
                            setCreateSchedules((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], day_of_week: Number(detail.selectedOption.value) };
                              return next;
                            })
                          }
                        />
                      </div>
                      <div style={{ width: "100px" }}>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={r.start}
                          onChange={({ detail }) =>
                            setCreateSchedules((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], start: detail.value };
                              return next;
                            })
                          }
                          placeholder="HH:MM"
                        />
                      </div>
                      <Box>to</Box>
                      <div style={{ width: "100px" }}>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={r.end}
                          onChange={({ detail }) =>
                            setCreateSchedules((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], end: detail.value };
                              return next;
                            })
                          }
                          placeholder="HH:MM"
                        />
                      </div>
                      <Button variant="inline-icon" iconName="remove" ariaLabel="Remove window" disabled={createSchedules.length <= 1} onClick={() => setCreateSchedules((prev) => prev.filter((_, idx) => idx !== i))} />
                    </div>
                  ))}
                  <Button iconName="add-plus" onClick={() => setCreateSchedules((prev) => [...prev, emptyInetSchedule()])}>Add window</Button>
                  <Box fontSize="body-s" color="text-body-secondary">
                    Overnight windows (e.g. 22:00 → 06:00) are supported (they’ll be split across days automatically).
                  </Box>
                </SpaceBetween>
              ) : null}
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Edit schedule modal */}
      <Modal
        visible={editScheduleFor != null}
        onDismiss={() => setEditScheduleFor(null)}
        header={`Edit schedule — ${editScheduleFor?.name || "Internet block"}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setEditScheduleFor(null)} disabled={editSaving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={editSaving}
                onClick={() => {
                  const r = editScheduleFor;
                  if (!r) return;
                  const schedules = expandScheduleRows(editSchedules);
                  setEditSaving(true);
                  api.internetBlockRulesUpdate(r.id, { enabled: r.enabled, schedules })
                    .then(() => load())
                    .then(() => setEditScheduleFor(null))
                    .catch((e) => setError(String(e)))
                    .finally(() => setEditSaving(false));
                }}
              >
                Save
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box fontSize="body-s" color="text-body-secondary">
            Empty schedule means <b>Always</b>. Overnight windows (22:00 → 06:00) are supported (split automatically).
          </Box>
          {editSchedules.map((r, i) => (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
              <div style={{ flex: "1 1 120px" }}>
                <Select
                  selectedOption={DAY_OPTIONS.find((o) => o.value === String(r.day_of_week)) ?? DAY_OPTIONS[1]}
                  options={DAY_OPTIONS}
                  onChange={({ detail }) =>
                    setEditSchedules((prev) => {
                      const next = [...prev];
                      next[i] = { ...next[i], day_of_week: Number(detail.selectedOption.value) };
                      return next;
                    })
                  }
                />
              </div>
              <div style={{ width: "100px" }}>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={r.start}
                  onChange={({ detail }) =>
                    setEditSchedules((prev) => {
                      const next = [...prev];
                      next[i] = { ...next[i], start: detail.value };
                      return next;
                    })
                  }
                  placeholder="HH:MM"
                />
              </div>
              <Box>to</Box>
              <div style={{ width: "100px" }}>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={r.end}
                  onChange={({ detail }) =>
                    setEditSchedules((prev) => {
                      const next = [...prev];
                      next[i] = { ...next[i], end: detail.value };
                      return next;
                    })
                  }
                  placeholder="HH:MM"
                />
              </div>
              <Button variant="inline-icon" iconName="remove" ariaLabel="Remove window" disabled={editSchedules.length <= 1} onClick={() => setEditSchedules((prev) => prev.filter((_, idx) => idx !== i))} />
            </div>
          ))}
          <Button iconName="add-plus" onClick={() => setEditSchedules((prev) => [...prev, emptyInetSchedule()])}>Add window</Button>
          <Button
            variant="link"
            onClick={() => setEditSchedules([emptyInetSchedule()])}
          >
            Reset to Always
          </Button>
        </SpaceBetween>
      </Modal>
    </>
  );
}

function EventsGlobalTab() {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [alertEvents, setAlertEvents] = useState<UnifiedEvent[]>([]);
  const [blockEvents, setBlockEvents] = useState<UnifiedEvent[]>([]);
  const [scriptEvents, setScriptEvents] = useState<UnifiedEvent[]>([]);
  const [sessionEvents, setSessionEvents] = useState<UnifiedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [alertData, blockData, scriptData, sessionData] = await Promise.all([
        api.alertRuleEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
        api.appBlockEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
        api.scheduledScriptEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
        api.agentSessionsAll({ limit: 500 }).catch(() => ({ rows: [] })),
      ]);

      setAlertEvents(
        (alertData.rows ?? []).map((r: Record<string, unknown>) => ({
          id: `a-${r.id}`,
          type: "alert" as const,
          agent_id: String(r.agent_id ?? ""),
          agent_name: String(r.agent_name ?? ""),
          rule_name: String(r.rule_name ?? ""),
          detail: String(r.snippet ?? ""),
          time: String(r.created_at ?? ""),
          screenshot_id: r.has_screenshot ? Number(r.id) : undefined,
          has_screenshot: Boolean(r.has_screenshot),
        })),
      );

      setBlockEvents(
        (blockData.rows).map((r) => ({
          id: `b-${r.id}`,
          type: "appblock" as const,
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          rule_name: r.rule_name ?? r.exe_name,
          detail: r.exe_name,
          time: r.killed_at,
        })),
      );

      setScriptEvents(
        (scriptData.rows).map((r) => ({
          id: `s-${r.script_id}-${r.agent_id}-${r.expected_fire_time}`,
          type: "script" as const,
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          rule_name: `${r.rule_name || "Unknown Script"}${r.is_manual ? " (manually triggered)" : ""}`,
          detail: r.output || "No output",
          status: r.status,
          time: r.expected_fire_time,
        })),
      );

      const sess = [];
      for (const r of sessionData.rows) {
        sess.push({
          id: `conn-${r.id}`,
          type: "connection" as const,
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          rule_name: "Agent Connected",
          detail: "Agent came online",
          time: r.connected_at,
        });
        if (r.disconnected_at) {
          sess.push({
            id: `disconn-${r.id}`,
            type: "connection" as const,
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            rule_name: "Agent Disconnected",
            detail: "Agent went offline",
            time: r.disconnected_at,
          });
        }
      }
      setSessionEvents(sess);

    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const allEvents = useMemo(() => {
    let src = [...alertEvents, ...blockEvents, ...scriptEvents, ...sessionEvents];
    if (filter === "alerts") src = alertEvents;
    if (filter === "appblock") src = blockEvents;
    if (filter === "scripts") src = scriptEvents;
    if (filter === "connections") src = sessionEvents;
    return src.sort((a, b) => b.time.localeCompare(a.time));
  }, [filter, alertEvents, blockEvents, scriptEvents, sessionEvents]);

  const { items: displayed, collectionProps, paginationProps } = useCollection(allEvents, {
    pagination: { pageSize: 50 },
    sorting: { defaultState: { sortingColumn: { sortingField: "time" }, isDescending: true } },
  });

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load, autoRefreshEnabled]);

  return (
    <>
      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Loading…"
        items={displayed}
        variant="container"
        stickyHeader
        header={
          <Header counter={`(${allEvents.length})`} actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Toggle
                checked={autoRefreshEnabled}
                onChange={({ detail }) => setAutoRefreshEnabled(detail.checked)}
              >
                Auto-refresh (30s)
              </Toggle>
              <Button iconName="refresh" variant="normal" onClick={() => void load()} loading={loading}>Refresh</Button>
              <SegmentedControl selectedId={filter} options={[
                { id: "all", text: "All" }, 
                { id: "alerts", text: "Alerts" }, 
                { id: "appblock", text: "App Block" },
                { id: "scripts", text: "Scripts" },
                { id: "connections", text: "Connections" }
              ]}
                onChange={({ detail }) => setFilter(detail.selectedId as EventFilter)} />
            </SpaceBetween>
          }>Global Events</Header>
        }
        pagination={<Pagination {...paginationProps} />}
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No events yet.</Box>}
        columnDefinitions={[
          { id: "time", header: "Time", cell: (r) => fmtDateTime(r.time), sortingField: "time", width: 170 },
          { id: "type", header: "Type", cell: (r) => <Badge color={r.type === "alert" ? "blue" : r.type === "appblock" ? "red" : r.type === "script" ? "green" : "grey"}>{r.type === "alert" ? "Alert" : r.type === "appblock" ? "App Block" : r.type === "script" ? "Script" : "Connection"}</Badge>, width: 110 },
          { id: "agent", header: "Agent", cell: (r) => r.agent_name, width: 180 },
          { id: "rule", header: "Rule/Event", cell: (r) => r.rule_name || "—", width: 200 },
          { id: "status", header: "Status", cell: (r) => r.status ? <Badge color={r.status.includes("error") || r.status.includes("failed") ? "red" : r.status.includes("skipped") ? "grey" : "green"}>{r.status}</Badge> : <Box color="text-body-secondary">—</Box>, width: 110 },
          { id: "detail", header: "Detail", cell: (r) => <div style={{ fontSize: "14px", maxHeight: 100, overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{r.detail || "—"}</span></div> },
          { id: "shot", header: "Screenshot", width: 110, cell: (r) => r.has_screenshot && r.screenshot_id ? <Button variant="inline-link" iconName="zoom-to-fit" onClick={() => setPreviewEventId(r.screenshot_id!)}>View</Button> : <Box color="text-body-secondary" fontSize="body-s">—</Box> },
          {
            id: "timeline",
            header: "Actions",
            width: 110,
            minWidth: 120,
            cell: (r) => (
              <Button
                variant="inline-link"
                iconName="angle-right"
                href={`/agents/${r.agent_id}?tab=activity&at=${encodeURIComponent(r.time)}`}
              >
                View
              </Button>
            ),
          },
        ]}
      />
      <ScreenshotModal eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </>
  );
}

// ── Scheduled Scripts tab ───────────────────────────────────────────────────────

function ScheduledScriptsTab({ groups, agents }: { groups: AgentGroup[]; agents: Agent[] }) {
  const [rules, setRules] = useState<import("../lib/types").ScheduledScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editRule, setEditRule] = useState<import("../lib/types").ScheduledScript | null>(null);
  // Map of script_id → last execution info
  const [lastRuns, setLastRuns] = useState<Record<number, { status: string; time: string }>>({});
  // Timezone from server capabilities
  const [schedulerTz, setSchedulerTz] = useState<string>("UTC");

  // Load server timezone once on mount
  useEffect(() => {
    api.capabilities().then(c => { if (c.scheduler_timezone) setSchedulerTz(c.scheduler_timezone); }).catch(() => {});
  }, []);
  const [editName, setEditName] = useState("");
  const [editShell, setEditShell] = useState("powershell");
  const [editScript, setEditScript] = useState("");
  const [editTimeout, setEditTimeout] = useState("120");

  const [editScopes, setEditScopes] = useState<InetScopeFormRow[]>([emptyInetScope()]);
  const [editSchedules, setEditSchedules] = useState<(import("../lib/types").ScheduledScriptSchedule & { timeStr?: string })[]>([{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]);

  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));
  const SCOPE_OPTS = [{ label: "All agents", value: "all" }, { label: "Agent group", value: "group" }, { label: "Single agent", value: "agent" }];

  const DAY_OPTIONS = [
    { label: "Sunday", value: "0" },
    { label: "Monday", value: "1" },
    { label: "Tuesday", value: "2" },
    { label: "Wednesday", value: "3" },
    { label: "Thursday", value: "4" },
    { label: "Friday", value: "5" },
    { label: "Saturday", value: "6" },
  ];

  const timeToMinute = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    const hhRaw = parseInt(m[1], 10);
    const mmRaw = parseInt(m[2], 10);
    const mm = Math.max(0, Math.min(59, mmRaw));
    if (hhRaw === 24 && mm === 0) return 1440;
    const hh = Math.max(0, Math.min(23, hhRaw));
    return hh * 60 + mm;
  };



  const minuteToTime = (min: number): string => {
    const m = Math.max(0, Math.min(1440, Math.floor(min)));
    if (m === 1440) return "24:00";
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const scheduleSummary = (schedules: import("../lib/types").ScheduledScriptSchedule[]) => {
    if (!schedules || schedules.length === 0) return <Box color="text-body-secondary">None</Box>;
    const s = schedules[0];
    if (s.frequency === "hourly") return `Hourly at minute ${s.fire_minute}`;
    const timeStr = minuteToTime(s.fire_minute);
    if (s.frequency === "daily") return `Daily at ${timeStr}`;
    if (s.frequency === "weekly") {
      const day = s.day_of_week != null ? (DAY_OPTIONS.find(o => String(o.value) === String(s.day_of_week))?.label ?? "?") : "?";
      return `Weekly on ${day} at ${timeStr}`;
    }
    return "?";
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [scriptsData, eventsData] = await Promise.all([
        api.scheduledScriptsList(),
        api.scheduledScriptEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
      ]);
      setRules(scriptsData.scripts ?? []);
      // Build last-run map: pick most recent event per script
      const runs: Record<number, { status: string; time: string }> = {};
      for (const ev of eventsData.rows) {
        const existing = runs[ev.script_id];
        if (!existing || ev.expected_fire_time > existing.time) {
          runs[ev.script_id] = { status: ev.status, time: ev.expected_fire_time };
        }
      }
      setLastRuns(runs);
    }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const updateScope = (i: number, patch: Partial<InetScopeFormRow>) => {
    setEditScopes((prev) => {
      const next = [...prev];
      const cur = { ...next[i], ...patch };
      if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
      if (patch.kind === "group") cur.agent_id = "";
      if (patch.kind === "agent") cur.group_id = "";
      next[i] = cur;
      return next;
    });
  };

  const openCreate = () => {
    setModalMode("create");
    setEditRule(null);
    setEditName("");
    setEditShell("powershell");
    setEditScript("");
    setEditTimeout("120");
    setEditScopes([emptyInetScope()]);
    setEditSchedules([{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]);
    setShowModal(true);
  };

  const openEdit = (r: import("../lib/types").ScheduledScript) => {
    setModalMode("edit");
    setEditRule(r);
    setEditName(r.name);
    setEditShell(r.shell);
    setEditScript(r.script);
    setEditTimeout(String(r.timeout_secs));

    const sc = (r.scopes && r.scopes.length > 0) ? r.scopes : [{ kind: "all" as const }];
    setEditScopes(sc.map(s => ({ kind: s.kind, group_id: s.group_id ?? "", agent_id: s.agent_id ?? "" })));

    const sched = Array.isArray(r.schedules) ? r.schedules : [];
    setEditSchedules(
      sched.length > 0
        ? sched.map(s => ({ ...s, timeStr: minuteToTime(s.fire_minute) }))
        : [{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]
    );
    setShowModal(true);
  };

  const saveRule = async () => {
    if (!editName.trim()) { setError("Name is required"); return; }
    if (!editScript.trim()) { setError("Script is required"); return; }

    setSaving(true); setError(null);
    try {
      const body = {
        name: editName.trim(),
        shell: editShell,
        script: editScript,
        timeout_secs: parseInt(editTimeout, 10) || 120,
        scopes: editScopes.map((s) => ({ kind: s.kind, group_id: s.group_id || undefined, agent_id: s.agent_id || undefined })),
        schedules: editSchedules.map(s => ({
          frequency: s.frequency,
          fire_minute: s.fire_minute,
          day_of_week: s.frequency === "weekly" ? (s.day_of_week ?? 0) : null
        })),
      };

      if (modalMode === "create") {
        await api.scheduledScriptsCreate(body);
      } else {
        await api.scheduledScriptsUpdate(editRule!.id, body);
      }

      setShowModal(false);
      await load();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  const toggleRule = (r: import("../lib/types").ScheduledScript) => {
    setTogglingId(r.id);
    api.scheduledScriptsUpdate(r.id, { enabled: !r.enabled })
      .then(() => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
      .catch((e) => setError(String(e)))
      .finally(() => setTogglingId(null));
  };

  const deleteRule = async (r: import("../lib/types").ScheduledScript) => {
    if (!confirm(`Delete scheduled script "${r.name}"?`)) return;
    try { await api.scheduledScriptsDelete(r.id); setRules((prev) => prev.filter((x) => x.id !== r.id)); }
    catch (e) { setError(String(e)); }
  };

  const triggerNow = async (r: import("../lib/types").ScheduledScript) => {
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await api.scheduledScriptsTrigger(r.id);
      setSuccessMsg(`Script "${r.name}" triggered for ${res.agent_count} agent(s). Results will appear in the Events tab within a few seconds.`);
      // Reload after a short delay to pick up the new execution record
      setTimeout(() => void load(), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);

  return (
    <>
      {error && <Box color="text-status-error" padding={{ bottom: "s" }}>{error}</Box>}
      {successMsg && <Box color="text-status-success" padding={{ bottom: "s" }}>{successMsg}</Box>}

      <Table
        loading={loading}
        loadingText="Loading…"
        items={rules}
        variant="container"
        stickyHeader
        header={
          <Header counter={`(${rules.length})`} actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="primary" iconName="add-plus" onClick={openCreate}>New script</Button>
            </SpaceBetween>
          }>Scheduled Scripts</Header>
        }
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No scheduled scripts.</Box>}
        columnDefinitions={[
          { id: "name", header: "Name", cell: (r) => r.name, width: "22%" },
          { id: "shell", header: "Shell", cell: (r) => r.shell, width: "8%" },
          { id: "scope", header: "Scope", cell: (r) => scopeBadge(r.scopes as unknown as AlertRuleScope[], groups, agentsById), width: "18%" },
          { id: "schedule", header: "Schedule", cell: (r) => scheduleSummary(r.schedules), width: "18%" },
          {
            id: "last_run",
            header: "Last Run",
            width: "15%",
            cell: (r) => {
              const lr = lastRuns[r.id];
              if (!lr) return <Box color="text-body-secondary" fontSize="body-s">Never</Box>;
              const statusColor = lr.status === "success" ? "green" : lr.status.includes("error") || lr.status === "failed" ? "red" : lr.status.includes("skipped") ? "grey" : "blue";
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <Badge color={statusColor}>{lr.status}</Badge>
                  <Box fontSize="body-s" color="text-body-secondary">{fmtDateTime(lr.time)}</Box>
                </div>
              );
            }
          },
          { id: "enabled", header: "Active", cell: (r) => <Toggle checked={r.enabled} disabled={togglingId === r.id} onChange={() => toggleRule(r)} />, width: 80 },
          {
            id: "actions",
            header: "Actions",
            width: 130,
            minWidth: 130,
            cell: (r) => (
              <ButtonDropdown
                expandToViewport
                items={[
                  { id: "edit", text: "Edit" },
                  { id: "trigger", text: "Trigger now" },
                  { id: "delete", text: "Delete" },
                ]}
                onItemClick={({ detail }) => {
                  if (detail.id === "edit") openEdit(r);
                  if (detail.id === "trigger") void triggerNow(r);
                  if (detail.id === "delete") void deleteRule(r);
                }}
              >
                Actions
              </ButtonDropdown>
            ),
          },
        ]}
      />

      <Modal visible={showModal} onDismiss={() => setShowModal(false)} header={modalMode === "create" ? "New scheduled script" : `Edit scheduled script — ${editName}`}
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void saveRule()} loading={saving}>{modalMode === "create" ? "Create" : "Save"}</Button>
            </SpaceBetween>
          </Box>
        }>
        <SpaceBetween size="m">
          {error && <Box color="text-status-error">{error}</Box>}
          <FormField label="Name">
            <Input value={editName} onChange={({ detail }) => setEditName(detail.value)} placeholder="e.g. Daily Cleanup" />
          </FormField>
          <FormField label="Shell">
            <SegmentedControl
              selectedId={editShell}
              onChange={({ detail }) => setEditShell(detail.selectedId)}
              options={[{ id: "powershell", text: "PowerShell" }, { id: "cmd", text: "Command Prompt" }]}
            />
          </FormField>
          <FormField label="Script">
            <textarea
              className="awsui-textarea"
              style={{ width: "100%", height: "200px", fontFamily: "monospace", padding: "8px", resize: "vertical" }}
              value={editScript}
              onChange={(e) => setEditScript(e.target.value)}
              placeholder="# Write your script here"
            />
          </FormField>
          <FormField label="Timeout (seconds)">
            <Input type="number" value={editTimeout} onChange={({ detail }) => setEditTimeout(detail.value)} />
          </FormField>
          <FormField label="Scope" description="Which agents should run this script.">
            <SpaceBetween size="xs">
              {editScopes.map((s, i) => (
                <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                  <div style={{ flex: "1 1 150px" }}>
                    <Select selectedOption={SCOPE_OPTS.find((o) => o.value === s.kind) ?? SCOPE_OPTS[0]}
                      options={SCOPE_OPTS}
                      onChange={({ detail }) => updateScope(i, { kind: detail.selectedOption.value as InetScopeFormRow["kind"] })} />
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
                  {editScopes.length > 1 && (
                    <Button variant="inline-icon" iconName="remove" onClick={() => setEditScopes((p) => p.filter((_, j) => j !== i))} />
                  )}
                </div>
              ))}
              <Button variant="inline-link" iconName="add-plus" onClick={() => setEditScopes((p) => [...p, emptyInetScope()])}>Add scope</Button>
            </SpaceBetween>
          </FormField>

          <FormField label="Schedule" description={`Times are in ${schedulerTz} (the server's configured timezone). Use 'Trigger now' to test immediately without waiting for the schedule.`}>
            <SpaceBetween size="xs">
              {editSchedules.map((r, i) => (
                <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                  <div style={{ flex: "1 1 120px" }}>
                    <Select
                      selectedOption={{ label: r.frequency.charAt(0).toUpperCase() + r.frequency.slice(1), value: r.frequency }}
                      options={[
                        { label: "Hourly", value: "hourly" },
                        { label: "Daily", value: "daily" },
                        { label: "Weekly", value: "weekly" }
                      ]}
                      onChange={({ detail }) => setEditSchedules((prev) => {
                        const next = [...prev];
                        next[i] = { ...next[i], frequency: detail.selectedOption.value as "hourly"|"daily"|"weekly" };
                        return next;
                      })}
                    />
                  </div>
                  {r.frequency === "weekly" && (
                    <div style={{ flex: "1 1 120px" }}>
                      <Select
                        selectedOption={DAY_OPTIONS.find((o) => o.value === String(r.day_of_week)) ?? DAY_OPTIONS[1]}
                        options={DAY_OPTIONS}
                        onChange={({ detail }) => setEditSchedules((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], day_of_week: Number(detail.selectedOption.value) };
                          return next;
                        })}
                      />
                    </div>
                  )}
                  {r.frequency === "hourly" ? (
                    <div style={{ display: "flex", gap: "4px", alignItems: "center", flex: "1 1 150px" }}>
                      <Box>at minute</Box>
                      <div style={{ width: "80px" }}>
                        <Input
                          type="number"
                          value={String(r.fire_minute)}
                          onChange={({ detail }) => setEditSchedules((prev) => {
                            const next = [...prev];
                            next[i] = { ...next[i], fire_minute: Math.max(0, Math.min(59, parseInt(detail.value) || 0)) };
                            return next;
                          })}
                        />
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: "4px", alignItems: "center", flex: "1 1 180px" }}>
                      <Box>at time</Box>
                      <div style={{ width: "100px" }}>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={r.timeStr ?? minuteToTime(r.fire_minute)}
                          onChange={({ detail }) => setEditSchedules((prev) => {
                            const next = [...prev];
                            const tm = timeToMinute(detail.value);
                            next[i] = { 
                              ...next[i], 
                              timeStr: detail.value,
                              // Only update fire_minute if the value parses, so half-typed strings don't corrupt it
                              ...(tm != null ? { fire_minute: tm } : {})
                            };
                            return next;
                          })}
                          placeholder="HH:MM"
                        />
                      </div>
                    </div>
                  )}
                  <Button variant="inline-icon" iconName="remove" ariaLabel="Remove schedule" disabled={editSchedules.length <= 1} onClick={() => setEditSchedules((prev) => prev.filter((_, idx) => idx !== i))} />
                </div>
              ))}
              <Button iconName="add-plus" onClick={() => setEditSchedules((prev) => [...prev, { frequency: "daily", fire_minute: 0 }])}>Add schedule</Button>
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Modal>
    </>
  );
}

// ── Main RulesPage ────────────────────────────────────────────────────────────

type RulesTabId = "alert-rules" | "app-blocking" | "internet-access" | "scheduled-scripts" | "events";

export function RulesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as RulesTabId) ?? "alert-rules";

  const setTab = (id: RulesTabId) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set("tab", id); return n; }, { replace: true });
  };

  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    void api.agentGroupsList().then((d) => setGroups(d.groups ?? [])).catch(() => { });
    void api.agentsOverview().then((d) => setAgents(d.agents ?? [])).catch(() => { });
  }, []);

  return (
    <ContentLayout header={<Header variant="h1" description="Manage alert rules, app blocking, and view all rule events across devices.">Rules</Header>}>
      <div className="vantyr-admin-page vantyr-rules-page sx-console">
      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setTab(detail.activeTabId as RulesTabId)}
        tabs={[
          { id: "alert-rules", label: "Alert Rules", content: <AlertRulesTab groups={groups} agents={agents} /> },
          { id: "app-blocking", label: "App Blocking", content: <AppBlockingTab groups={groups} agents={agents} /> },
          { id: "internet-access", label: "Internet Access", content: <InternetAccessTab groups={groups} agents={agents} /> },
          { id: "scheduled-scripts", label: "Scheduled Scripts", content: <ScheduledScriptsTab groups={groups} agents={agents} /> },
          { id: "events", label: "Events", content: <EventsGlobalTab /> },
        ]}
      />
      </div>
    </ContentLayout>
  );
}
