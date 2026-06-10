import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, FormField, Header, Input, Modal, Select, SpaceBetween, Table, Toggle } from "../ui/console";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import type { Agent, AgentGroup, ScheduledScript, ScheduledScriptSchedule } from "../../lib/types";
import { emptyScopeRow, formScopesToApi, inetScopeBadge, timeToMinute, minuteToTime, scheduledScriptScheduleSummary, type ScopeFormRow } from "./rulesUtils";

interface ScheduledScriptsTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

export function ScheduledScriptsTab({ groups, agents }: ScheduledScriptsTabProps) {
  const [rules, setRules] = useState<ScheduledScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editRule, setEditRule] = useState<ScheduledScript | null>(null);
  const [lastRuns, setLastRuns] = useState<Record<number, { status: string; time: string }>>({});
  const [schedulerTz, setSchedulerTz] = useState<string>("UTC");

  useEffect(() => {
    api.capabilities().then(c => { if (c.scheduler_timezone) setSchedulerTz(c.scheduler_timezone); }).catch(() => {});
  }, []);

  const [editName, setEditName] = useState("");
  const [editShell, setEditShell] = useState("powershell");
  const [editScript, setEditScript] = useState("");
  const [editTimeout, setEditTimeout] = useState("120");

  const [editScopes, setEditScopes] = useState<ScopeFormRow[]>([emptyScopeRow()]);
  const [editSchedules, setEditSchedules] = useState<(ScheduledScriptSchedule & { timeStr?: string })[]>([{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]);

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [scriptsData, eventsData] = await Promise.all([
        api.scheduledScriptsList(),
        api.scheduledScriptEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
      ]);
      setRules(scriptsData.scripts ?? []);
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

  const openCreate = () => {
    setModalMode("create");
    setEditRule(null);
    setEditName("");
    setEditShell("powershell");
    setEditScript("");
    setEditTimeout("120");
    setEditScopes([emptyScopeRow()]);
    setEditSchedules([{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]);
    setShowModal(true);
  };

  const openEdit = (r: ScheduledScript) => {
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
        timeout_secs: Math.max(1, parseInt(editTimeout, 10) || 120),
        scopes: formScopesToApi(editScopes).map(s => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })),
        schedules: editSchedules.map(s => {
          const min = s.timeStr ? (timeToMinute(s.timeStr) ?? 0) : s.fire_minute;
          return {
            frequency: s.frequency,
            fire_minute: min,
            day_of_week: s.frequency === "weekly" ? s.day_of_week : undefined,
          };
        }),
      };

      if (modalMode === "create") {
        await api.scheduledScriptsCreate(body);
      } else {
        await api.scheduledScriptsUpdate(editRule!.id, body);
      }
      setShowModal(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async (r: ScheduledScript) => {
    if (!confirm(`Delete scheduled script "${r.name}"?`)) return;
    setError(null);
    try {
      await api.scheduledScriptsDelete(r.id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleRule = async (r: ScheduledScript) => {
    setTogglingId(r.id);
    setError(null);
    try {
      await api.scheduledScriptsUpdate(r.id, { enabled: !r.enabled });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setTogglingId(null);
    }
  };

  const runScriptNow = async (r: ScheduledScript) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await api.scheduledScriptsTrigger(r.id);
      setSuccessMsg(`Script "${r.name}" enqueued for immediate execution on target agents.`);
      setTimeout(() => setSuccessMsg(null), 4000);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

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
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No scheduled scripts. Create one to run diagnostic/monitoring scripts periodically.</Box>}
        columnDefinitions={[
          { id: "name", header: "Name", cell: (r) => r.name || <Box color="text-body-secondary">Unnamed</Box>, width: "25%" },
          { id: "shell", header: "Shell", cell: (r) => <Badge color="grey">{r.shell}</Badge>, width: 100 },
          { id: "scope", header: "Scope", cell: (r) => inetScopeBadge(r, groups, agents), width: "20%" },
          { id: "schedule", header: "Schedule", cell: (r) => scheduledScriptScheduleSummary(r.schedules), width: "20%" },
          { id: "enabled", header: "Active", cell: (r) => <Toggle checked={r.enabled} disabled={togglingId === r.id} onChange={() => void toggleRule(r)} />, width: 80 },
          {
            id: "last_run",
            header: "Last Run Status",
            cell: (r) => {
              const run = lastRuns[r.id];
              if (!run) return <Box color="text-body-secondary">—</Box>;
              const badgeColor = run.status.includes("error") || run.status.includes("failed") ? "red" : "green";
              return (
                <SpaceBetween size="xs">
                  <Badge color={badgeColor}>{run.status}</Badge>
                  <span style={{ fontSize: "11px", color: "var(--text-3)" }}>{fmtDateTime(run.time)}</span>
                </SpaceBetween>
              );
            },
            width: 180,
          },
          {
            id: "actions",
            header: "Actions",
            width: 200,
            cell: (r) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => void runScriptNow(r)}>Run now</Button>
                <Button onClick={() => openEdit(r)}>Edit</Button>
                <Button variant="normal" onClick={() => void deleteRule(r)}>Delete</Button>
              </SpaceBetween>
            ),
          },
        ]}
      />

      {/* Edit / Create Modal */}
      {showModal && (
        <Modal
          visible
          onDismiss={() => setShowModal(false)}
          header={modalMode === "create" ? "New scheduled script" : `Edit scheduled script — ${editRule?.name}`}
          size="medium"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowModal(false)}>Cancel</Button>
                <Button variant="primary" onClick={() => void saveRule()} loading={saving}>Save</Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            {error && <Box color="text-status-error">{error}</Box>}
            <FormField label="Script name">
              <Input value={editName} onChange={({ detail }) => setEditName(detail.value)} placeholder="e.g. Health check script" />
            </FormField>

            <FormField label="Shell type">
              <Select
                selectedOption={{ label: editShell === "powershell" ? "PowerShell" : "CMD", value: editShell }}
                options={[
                  { label: "PowerShell", value: "powershell" },
                  { label: "CMD", value: "cmd" },
                ]}
                onChange={({ detail }) => setEditShell(detail.selectedOption.value)}
              />
            </FormField>

            <FormField label="Script code" description="Script will execute on the remote agent machine.">
              <textarea
                value={editScript}
                onChange={(e) => setEditScript(e.target.value)}
                rows={8}
                style={{
                  width: "100%",
                  fontFamily: "monospace",
                  background: "var(--bg-2)",
                  color: "var(--text)",
                  border: "1px solid var(--border-2)",
                  borderRadius: "var(--r)",
                  padding: "8px",
                }}
              />
            </FormField>

            <FormField label="Timeout (seconds)">
              <Input type="number" value={editTimeout} onChange={({ detail }) => setEditTimeout(detail.value)} />
            </FormField>

            <FormField label="Scope" description="Who this script runs on.">
              <SpaceBetween size="xs">
                {editScopes.map((s, i) => (
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
                    {editScopes.length > 1 && (
                      <Button variant="inline-icon" iconName="remove" onClick={() => setEditScopes((p) => p.filter((_, j) => j !== i))} />
                    )}
                  </div>
                ))}
                <Button variant="inline-link" iconName="add-plus" onClick={() => setEditScopes((p) => [...p, emptyScopeRow()])}>Add scope</Button>
              </SpaceBetween>
            </FormField>

            <FormField label={`Schedule (Timezone: ${schedulerTz})`}>
              <SpaceBetween size="xs">
                {editSchedules.map((s, i) => (
                  <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", borderBottom: "1px solid #eee", paddingBottom: "8px" }}>
                    <div style={{ flex: "1 1 120px" }}>
                      <Select
                        selectedOption={{ label: s.frequency, value: s.frequency }}
                        options={[
                          { label: "hourly", value: "hourly" },
                          { label: "daily", value: "daily" },
                          { label: "weekly", value: "weekly" },
                        ]}
                        onChange={({ detail }) =>
                          setEditSchedules(prev => {
                            const next = [...prev];
                            next[i] = { ...next[i], frequency: detail.selectedOption.value as any };
                            return next;
                          })
                        }
                      />
                    </div>
                    {s.frequency === "weekly" && (
                      <div style={{ flex: "1 1 120px" }}>
                        <Select
                          selectedOption={DAY_OPTIONS.find(o => String(o.value) === String(s.day_of_week ?? 1)) ?? DAY_OPTIONS[1]}
                          options={DAY_OPTIONS}
                          onChange={({ detail }) =>
                            setEditSchedules(prev => {
                              const next = [...prev];
                              next[i] = { ...next[i], day_of_week: Number(detail.selectedOption.value) };
                              return next;
                            })
                          }
                        />
                      </div>
                    )}
                    <div style={{ width: "100px" }}>
                      <Input
                        type="text"
                        value={s.timeStr ?? "00:00"}
                        onChange={({ detail }) =>
                          setEditSchedules(prev => {
                            const next = [...prev];
                            next[i] = { ...next[i], timeStr: detail.value };
                            return next;
                          })
                        }
                        placeholder={s.frequency === "hourly" ? "Minute (0-59)" : "HH:MM"}
                      />
                    </div>
                  </div>
                ))}
              </SpaceBetween>
            </FormField>
          </SpaceBetween>
        </Modal>
      )}
    </>
  );
}
