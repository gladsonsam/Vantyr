import { useCallback, useEffect, useState } from "react";
import { Box, Button, ButtonDropdown, Checkbox, FormField, Header, Input, Modal, Select, SpaceBetween, Table, Toggle } from "../ui/console";
import { api, errorText } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import type { Agent, AgentGroup, InternetBlockRule, RuleSchedule } from "../../lib/types";
import { emptyScopeRow, inetScopeBadge, timeToMinute, minuteToTime, scheduleSummary, type ScopeFormRow } from "./rulesUtils";

type InetScheduleFormRow = { day_of_week: number; start: string; end: string };

function emptyInetSchedule(): InetScheduleFormRow { return { day_of_week: 1, start: "00:00", end: "23:59" }; }

interface InternetAccessTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

export function InternetAccessTab({ groups, agents }: InternetAccessTabProps) {
  const [rules, setRules] = useState<InternetBlockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScopes, setCreateScopes] = useState<ScopeFormRow[]>([emptyScopeRow()]);
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
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: 1440 });
        out.push({ day_of_week: (r.day_of_week + 1) % 7, start_minute: 0, end_minute: e });
      }
    }
    return out;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.internetBlockRulesList(); setRules(d.rules ?? []); }
    catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const updateScope = (i: number, patch: Partial<ScopeFormRow>) => {
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
      setCreateScopes([emptyScopeRow()]);
      setCreateScheduled(false);
      setCreateSchedules([emptyInetSchedule()]);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  };

  const toggleRule = (r: InternetBlockRule) => {
    setTogglingId(r.id);
    api.internetBlockRulesUpdate(r.id, { enabled: !r.enabled })
      .then(() => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
      .catch((e) => setError(errorText(e)))
      .finally(() => setTogglingId(null));
  };

  const deleteRule = async (r: InternetBlockRule) => {
    if (!confirm(`Delete rule "${r.name || "Internet block"}"?`)) return;
    try { await api.internetBlockRulesDelete(r.id); setRules((prev) => prev.filter((x) => x.id !== r.id)); }
    catch (e) { setError(errorText(e)); }
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
          { id: "scope", header: "Scope", cell: (r) => inetScopeBadge(r, groups, agents), width: "25%" },
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
                      ? (r.schedules ?? []).map((w: RuleSchedule) => ({ day_of_week: w.day_of_week, start: minuteToTime(w.start_minute), end: minuteToTime(w.end_minute) }))
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
                    onChange={({ detail }) => updateScope(i, { kind: detail.selectedOption.value as ScopeFormRow["kind"] })} />
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
              <Button variant="inline-link" iconName="add-plus" onClick={() => setCreateScopes((p) => [...p, emptyScopeRow()])}>Add scope</Button>
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
                    .catch((e) => setError(errorText(e)))
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
