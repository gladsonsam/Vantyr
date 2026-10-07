import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, errorText } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import { settingsQueries } from "@/api/queries/settings";
import { fmtDateTime } from "@/lib/utils";
import type { Agent, AgentGroup, ScheduledScript, ScheduledScriptEvent, ScheduledScriptSchedule } from "@/api/types";
import { emptyScopeRow, formScopesToApi, inetScopeBadge, timeToMinute, minuteToTime, scheduledScriptScheduleSummary, type ScopeFormRow } from "./rulesUtils";
import { FormSelect } from "@/components/common/form/FormSelect";

interface ScheduledScriptsTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

type LastRuns = Record<number, { status: string; time: string }>;

const NO_SCRIPTS: ScheduledScript[] = [];
const NO_RUNS: LastRuns = {};
const EVENTS_PAGE = { limit: 500 };

const toScripts = (d: { scripts: ScheduledScript[] }) => d.scripts ?? NO_SCRIPTS;

/** Latest run per script, from the global run feed. */
function toLastRuns(data: { rows: ScheduledScriptEvent[] }): LastRuns {
  const runs: LastRuns = {};
  for (const ev of data.rows) {
    const existing = runs[ev.script_id];
    if (!existing || ev.expected_fire_time > existing.time) {
      runs[ev.script_id] = { status: ev.status, time: ev.expected_fire_time };
    }
  }
  return runs;
}

type ScheduledScriptBody = Parameters<typeof api.scheduledScriptsCreate>[0];

const SCOPE_OPTS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

const FREQUENCY_OPTIONS = [
  { label: "hourly", value: "hourly" },
  { label: "daily", value: "daily" },
  { label: "weekly", value: "weekly" },
];

function runStatusClass(status: string): string {
  if (status.includes("error") || status.includes("failed")) return "text-destructive";
  return "text-success";
}

export function ScheduledScriptsTab({ groups, agents }: ScheduledScriptsTabProps) {
  const queryClient = useQueryClient();
  const scriptsQuery = useQuery({ ...ruleQueries.scheduledScripts(), select: toScripts });
  const rules = scriptsQuery.data ?? NO_SCRIPTS;
  // The run feed is best-effort: if it fails the "Last Run Status" column just shows dashes.
  const runsQuery = useQuery({ ...ruleQueries.scheduledScriptEventsAll(EVENTS_PAGE), select: toLastRuns });
  const lastRuns = runsQuery.isError ? NO_RUNS : runsQuery.data ?? NO_RUNS;
  const loading = scriptsQuery.isFetching || runsQuery.isFetching;
  // Validation and mutation failures; a failed list load comes from the query.
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? (scriptsQuery.error ? errorText(scriptsQuery.error) : null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editRule, setEditRule] = useState<ScheduledScript | null>(null);
  const schedulerTz = useQuery(settingsQueries.capabilities()).data?.scheduler_timezone || "UTC";

  const [editName, setEditName] = useState("");
  const [editShell, setEditShell] = useState("powershell");
  const [editScript, setEditScript] = useState("");
  const [editTimeout, setEditTimeout] = useState("120");

  const [editScopes, setEditScopes] = useState<ScopeFormRow[]>([emptyScopeRow()]);
  const [editSchedules, setEditSchedules] = useState<(ScheduledScriptSchedule & { timeStr?: string })[]>([{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]);

  const [deleteRule, setDeleteRule] = useState<ScheduledScript | null>(null);

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

  // Scripts and their run feed share the `scheduledScripts` key prefix, so this reloads both.
  const refreshScripts = () => queryClient.invalidateQueries({ queryKey: ruleKeys.scheduledScripts() });

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: ScheduledScriptBody }) => {
      if (id === null) await api.scheduledScriptsCreate(body);
      else await api.scheduledScriptsUpdate(id, body);
    },
    onSuccess: async () => {
      setShowModal(false);
      await refreshScripts();
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const saving = save.isPending;

  const remove = useMutation({
    mutationFn: (id: number) => api.scheduledScriptsDelete(id),
    onSuccess: async () => {
      setDeleteRule(null);
      await refreshScripts();
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const deleting = remove.isPending;

  const toggle = useMutation({
    mutationFn: (r: ScheduledScript) => api.scheduledScriptsUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: () => refreshScripts(),
    onError: (e) => setLocalError(errorText(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.id : null;

  const trigger = useMutation({
    mutationFn: (r: ScheduledScript) => api.scheduledScriptsTrigger(r.id),
    onSuccess: async (_, r) => {
      setSuccessMsg(`Script "${r.name}" enqueued for immediate execution on target agents.`);
      setTimeout(() => setSuccessMsg(null), 4000);
      await refreshScripts();
    },
    onError: (e) => setLocalError(errorText(e)),
  });

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

  const saveRule = () => {
    if (!editName.trim()) { setLocalError("Name is required"); return; }
    if (!editScript.trim()) { setLocalError("Script is required"); return; }

    setLocalError(null);
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
    save.mutate({ id: modalMode === "create" ? null : editRule!.id, body });
  };

  const confirmDelete = () => {
    if (!deleteRule) return;
    setLocalError(null);
    remove.mutate(deleteRule.id);
  };

  const toggleRule = (r: ScheduledScript) => {
    setLocalError(null);
    toggle.mutate(r);
  };

  const runScriptNow = (r: ScheduledScript) => {
    setLocalError(null);
    setSuccessMsg(null);
    trigger.mutate(r);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) => (r.name || "").toLowerCase().includes(q));
  }, [rules, query]);
  const pagesCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pagesCount);
  const displayed = useMemo(
    () => filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filtered, activePage],
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {successMsg && (
        <Alert role="status">
          <AlertDescription className="text-success">{successMsg}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="h-9 min-w-0 flex-1 sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search scheduled scripts"
            placeholder="Search scripts…"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => { setQuery(""); setPage(1); }}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Button onClick={openCreate}>
          <Plus /> New script
        </Button>
      </div>

      {loading && rules.length === 0 ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : displayed.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyTitle>{query ? "No scripts match" : "No scheduled scripts"}</EmptyTitle>
            <EmptyDescription>
              {query
                ? "No scripts match the current search."
                : "Create one to run diagnostic/monitoring scripts periodically."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5!">Name</TableHead>
                <TableHead className="w-24">Shell</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-44">Last Run Status</TableHead>
                <TableHead className="w-28 pr-5! text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {displayed.map((r) => {
                const run = lastRuns[r.id];
                return (
                  <TableRow key={r.id}>
                    <TableCell className="pl-5! font-medium">
                      {r.name || <span className="text-muted-foreground">Unnamed</span>}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">{r.shell}</span>
                    </TableCell>
                    <TableCell>{inetScopeBadge(r, groups, agents)}</TableCell>
                    <TableCell>{scheduledScriptScheduleSummary(r.schedules)}</TableCell>
                    <TableCell>
                      <Checkbox
                        aria-label={`${r.enabled ? "Disable" : "Enable"} script ${r.name}`}
                        checked={r.enabled}
                        disabled={togglingId === r.id}
                        onCheckedChange={() => toggleRule(r)}
                      />
                    </TableCell>
                    <TableCell>
                      {!run ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <span className={`text-xs font-medium ${runStatusClass(run.status)}`}>{run.status}</span>
                          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{fmtDateTime(run.time)}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="pr-5!">
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`} />}>
                            <MoreHorizontal />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => runScriptNow(r)}>
                              <Play /> Run now
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEdit(r)}>
                              <Pencil /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteRule(r)}>
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              Page {activePage} of {pagesCount} · {filtered.length} script{filtered.length === 1 ? "" : "s"}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={activePage <= 1} onClick={() => setPage(activePage - 1)} aria-label="Previous page">
                <ChevronLeft /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={activePage >= pagesCount} onClick={() => setPage(activePage + 1)} aria-label="Next page">
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={showModal} onOpenChange={(open) => { if (!open) setShowModal(false); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{modalMode === "create" ? "New scheduled script" : `Edit scheduled script — ${editRule?.name}`}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <Field>
              <FieldLabel htmlFor="script-name">Script name</FieldLabel>
              <Input
                id="script-name"
                className="h-9"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                placeholder="e.g. Health check script"
              />
            </Field>

            <Field>
              <FieldLabel>Shell type</FieldLabel>
              <FormSelect
                ariaLabel="Shell type"
                value={editShell}
                options={[
                  { label: "PowerShell", value: "powershell" },
                  { label: "CMD", value: "cmd" },
                ]}
                onChange={setEditShell}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="script-code">Script code</FieldLabel>
              <Textarea
                id="script-code"
                value={editScript}
                onChange={(event) => setEditScript(event.target.value)}
                rows={8}
                className="font-mono"
              />
              <FieldDescription>Script will execute on the remote agent machine.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="script-timeout">Timeout (seconds)</FieldLabel>
              <Input
                id="script-timeout"
                className="h-9"
                type="number"
                value={editTimeout}
                onChange={(event) => setEditTimeout(event.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel>Scope</FieldLabel>
              <div className="flex flex-col gap-3">
                {editScopes.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <div className="min-w-36 flex-1">
                      <FormSelect
                        ariaLabel={`Scope ${i + 1} kind`}
                        value={s.kind}
                        options={SCOPE_OPTS}
                        onChange={(value) => updateScope(i, { kind: value as ScopeFormRow["kind"] })}
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
                    {editScopes.length > 1 && (
                      <Button variant="ghost" size="sm" aria-label={`Remove scope ${i + 1}`} onClick={() => setEditScopes((p) => p.filter((_, j) => j !== i))}>
                        <X /> Remove
                      </Button>
                    )}
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setEditScopes((p) => [...p, emptyScopeRow()])}>
                  <Plus /> Add scope
                </Button>
              </div>
              <FieldDescription>Who this script runs on.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Schedule (Timezone: {schedulerTz})</FieldLabel>
              <div className="flex flex-col gap-3">
                {editSchedules.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                    <div className="min-w-32 flex-1">
                      <FormSelect
                        ariaLabel={`Schedule ${i + 1} frequency`}
                        value={s.frequency}
                        options={FREQUENCY_OPTIONS}
                        onChange={(value) => setEditSchedules((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], frequency: value as ScheduledScriptSchedule["frequency"] };
                          return next;
                        })}
                      />
                    </div>
                    {s.frequency === "weekly" && (
                      <div className="min-w-32 flex-1">
                        <FormSelect
                          ariaLabel={`Schedule ${i + 1} day`}
                          value={String(s.day_of_week ?? 1)}
                          options={DAY_OPTIONS}
                          onChange={(value) => setEditSchedules((prev) => {
                            const next = [...prev];
                            next[i] = { ...next[i], day_of_week: Number(value) };
                            return next;
                          })}
                        />
                      </div>
                    )}
                    <Input
                      aria-label={`Schedule ${i + 1} time`}
                      className="h-9 w-28"
                      value={s.timeStr ?? "00:00"}
                      onChange={(event) => setEditSchedules((prev) => {
                        const next = [...prev];
                        next[i] = { ...next[i], timeStr: event.target.value };
                        return next;
                      })}
                      placeholder={s.frequency === "hourly" ? "Minute (0-59)" : "HH:MM"}
                    />
                  </div>
                ))}
              </div>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={saveRule} disabled={saving}>
              {saving && <Spinner />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteRule !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteRule(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scheduled script?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete scheduled script <strong className="text-foreground">{deleteRule?.name}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={confirmDelete}>
              {deleting && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
