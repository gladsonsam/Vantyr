import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, ButtonDropdown, Checkbox, FormField, Header, Input, Modal, Pagination, SegmentedControl, Select, SpaceBetween, Table, Toggle, TextFilter } from "../ui/console";
import { useCollection } from "../../hooks/useCollection";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { AppIcon } from "../common/AppIcon";
import type { Agent, AgentGroup, AppBlockRule, AppBlockRuleScope, AppBlockEvent } from "../../lib/types";
import { emptyScopeRow, formScopesToApi, appBlockScopeBadge, scopesToForm, type ScopeFormRow, timeToMinute, minuteToTime, scheduleSummary } from "./rulesUtils";

interface AppBlockingTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

export function AppBlockingTab({ groups, agents }: AppBlockingTabProps) {
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
    setEditScopes(scopesToForm(scopes as unknown as AppBlockRuleScope[]));
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
                  const scopes = formScopesToApi(editScopes);
                  const schedules = editScheduled ? expandScheduleRows(editScheduleRows) : [];

                  const body = {
                    name: editLabel.trim() || pattern,
                    exe_pattern: pattern,
                    match_mode: editMatchMode,
                    scopes: scopes.map((s) => ({
                      kind: s.kind,
                      group_id: s.group_id,
                      agent_id: s.agent_id,
                    })),
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
