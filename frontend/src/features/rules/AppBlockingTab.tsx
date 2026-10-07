import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MoreHorizontal, History, Pencil, Plus, Search, Trash2, X } from "lucide-react";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, errorText } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import { fmtDateTime } from "@/lib/utils";
import { AppIcon } from "@/components/common/AppIcon";
import type { Agent, AgentGroup, AppBlockRule, AppBlockRuleScope, AppBlockEvent } from "@/api/types";
import { emptyScopeRow, formScopesToApi, appBlockScopeBadge, scopesToForm, type ScopeFormRow, timeToMinute, minuteToTime, scheduleSummary } from "./rulesUtils";
import { FormSelect } from "@/components/common/form/FormSelect";

interface AppBlockingTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

const NO_RULES: AppBlockRule[] = [];
const NO_EVENTS: AppBlockEvent[] = [];
const HISTORY_PAGE = { limit: 200 };

const toRules = (d: { rules: AppBlockRule[] }) => d.rules ?? NO_RULES;
const toEvents = (d: { rows: AppBlockEvent[] }) => d.rows;

type AppBlockRuleBody = Parameters<typeof api.appBlockRulesCreate>[0];

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

const SCOPE_OPTIONS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

export function AppBlockingTab({ groups, agents }: AppBlockingTabProps) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ ...ruleQueries.appBlockRules(), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;
  const loading = rulesQuery.isFetching;
  // Validation and mutation failures; a failed list load comes from the query.
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? (rulesQuery.error ? errorText(rulesQuery.error) : null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [editRule, setEditRule] = useState<AppBlockRule | null>(null);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editExePattern, setEditExePattern] = useState("");
  const [editMatchMode, setEditMatchMode] = useState<"contains" | "exact">("contains");
  const [editLabel, setEditLabel] = useState("");
  const [editScopes, setEditScopes] = useState<ScopeFormRow[]>([emptyScopeRow()]);
  const [editScheduled, setEditScheduled] = useState(false);
  const [editScheduleRows, setEditScheduleRows] = useState<Array<{ day_of_week: number; start: string; end: string }>>([
    { day_of_week: 1, start: "00:00", end: "23:59" },
  ]);
  const [historyRule, setHistoryRule] = useState<AppBlockRule | null>(null);
  const historyQuery = useQuery({
    ...ruleQueries.appBlockEventsForRule(historyRule?.id ?? 0, HISTORY_PAGE),
    enabled: historyRule !== null,
    select: toEvents,
  });
  // A failed history load shows an empty list.
  const historyEvents = historyQuery.isError ? NO_EVENTS : historyQuery.data ?? NO_EVENTS;
  const historyLoading = historyQuery.isFetching;
  const [deleteRule, setDeleteRule] = useState<AppBlockRule | null>(null);

  const openHistory = (r: AppBlockRule) => setHistoryRule(r);

  const listKey = ruleQueries.appBlockRules().queryKey;

  const toggle = useMutation({
    mutationFn: (r: AppBlockRule) => api.appBlockRulesUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: (_, r) =>
      queryClient.setQueryData(listKey, (prev) =>
        prev && { ...prev, rules: prev.rules.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x) }),
    onError: (e) => setLocalError(errorText(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.id : null;

  const remove = useMutation({
    mutationFn: (r: AppBlockRule) => api.appBlockRulesDelete(r.id),
    onSuccess: (_, r) => {
      queryClient.setQueryData(listKey, (prev) => prev && { ...prev, rules: prev.rules.filter((x) => x.id !== r.id) });
      setDeleteRule(null);
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const deleting = remove.isPending;

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: AppBlockRuleBody }) => {
      if (id === null) await api.appBlockRulesCreate(body);
      else await api.appBlockRulesUpdate(id, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ruleKeys.appBlockRules() });
      setShowModal(false);
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const editSaving = save.isPending;

  const toggleRule = (r: AppBlockRule) => toggle.mutate(r);

  const confirmDelete = () => {
    if (!deleteRule) return;
    remove.mutate(deleteRule);
  };

  const saveRule = () => {
    const pattern = editExePattern.trim();
    if (!pattern) {
      setLocalError("EXE name is required.");
      return;
    }
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

    save.mutate({ id: modalMode === "create" ? null : editRule!.id, body });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) => r.exe_pattern.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q));
  }, [rules, query]);
  const pagesCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pagesCount);
  const displayed = useMemo(
    () => filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filtered, activePage],
  );

  const contextAgentId = agents[0]?.id ?? "";

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

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
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="h-9 min-w-0 flex-1 sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search app block rules"
            placeholder="Search rules…"
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
          <Plus /> New rule
        </Button>
      </div>

      {loading && rules.length === 0 ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : displayed.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyTitle>{query ? "No rules match" : "No app block rules yet"}</EmptyTitle>
            <EmptyDescription>
              {query ? "No rules match the current search." : "Create one to block apps on managed devices."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5!">EXE name</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-24 pr-5! text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {displayed.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5!">
                    <div className="flex items-center gap-2">
                      {contextAgentId && <AppIcon agentId={contextAgentId} exeName={r.exe_pattern} size={18} />}
                      <span className="font-mono text-xs">{r.exe_pattern}</span>
                      <span className="text-xs text-muted-foreground">{r.match_mode}</span>
                    </div>
                  </TableCell>
                  <TableCell>{r.name || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{appBlockScopeBadge(r, groups, agentsById)}</TableCell>
                  <TableCell>{scheduleSummary(r.schedules)}</TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`${r.enabled ? "Disable" : "Enable"} block rule ${r.name || r.exe_pattern}`}
                      checked={r.enabled}
                      disabled={togglingId === r.id}
                      onCheckedChange={() => toggleRule(r)}
                    />
                  </TableCell>
                  <TableCell className="pr-5!">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name || r.exe_pattern}`} />}>
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(r)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openHistory(r)}>
                            <History /> Kill history
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteRule(r)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              Page {activePage} of {pagesCount} · {filtered.length} rule{filtered.length === 1 ? "" : "s"}
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
            <DialogTitle>{modalMode === "create" ? "Add app block rule" : `Edit app block rule — ${editRule?.name || editRule?.exe_pattern || ""}`}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <Field>
              <FieldLabel htmlFor="appblock-exe">EXE name</FieldLabel>
              <Input
                id="appblock-exe"
                className="h-9"
                value={editExePattern}
                onChange={(event) => setEditExePattern(event.target.value)}
                placeholder="e.g. tiktok.exe"
              />
              <FieldDescription>Executable file name to block (e.g. tiktok.exe).</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Match mode</FieldLabel>
              <ToggleGroup
                size="sm"
                spacing={0}
                className="rounded-lg bg-muted/70 p-0.5"
                aria-label="Match mode"
                value={[editMatchMode]}
                onValueChange={(value) => {
                  const next = value[0] as "contains" | "exact" | undefined;
                  if (next) setEditMatchMode(next);
                }}
              >
                <ToggleGroupItem value="contains" aria-label="Contains" className="rounded-md! px-3 aria-pressed:bg-background">
                  Contains
                </ToggleGroupItem>
                <ToggleGroupItem value="exact" aria-label="Exact" className="rounded-md! px-3 aria-pressed:bg-background">
                  Exact
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="appblock-label">Label</FieldLabel>
              <Input
                id="appblock-label"
                className="h-9"
                value={editLabel}
                onChange={(event) => setEditLabel(event.target.value)}
                placeholder="Optional"
              />
            </Field>
            <Field>
              <FieldLabel>Scope</FieldLabel>
              <div className="flex flex-col gap-3">
                {editScopes.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                    <div className="min-w-36 flex-1">
                      <FormSelect
                        ariaLabel={`Scope ${i + 1} kind`}
                        value={s.kind}
                        options={SCOPE_OPTIONS}
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
              <FieldDescription>Which agents this rule applies to.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Schedule (optional)</FieldLabel>
              <div className="flex flex-col gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={editScheduled} onCheckedChange={(checked) => setEditScheduled(checked === true)} />
                  Enable schedule (curfew)
                </label>
                {editScheduled && (
                  <div className="flex flex-col gap-3">
                    {editScheduleRows.map((r, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                        <div className="min-w-32 flex-1">
                          <FormSelect
                            ariaLabel={`Window ${i + 1} day`}
                            value={String(r.day_of_week)}
                            options={DAY_OPTIONS}
                            onChange={(value) => setEditScheduleRows((prev) => {
                              const next = [...prev];
                              next[i] = { ...next[i], day_of_week: Number(value) };
                              return next;
                            })}
                          />
                        </div>
                        <Input
                          aria-label={`Window ${i + 1} start time`}
                          className="h-9 w-24"
                          inputMode="numeric"
                          value={r.start}
                          onChange={(event) => setEditScheduleRows((prev) => {
                            const next = [...prev];
                            next[i] = { ...next[i], start: event.target.value };
                            return next;
                          })}
                          placeholder="HH:MM"
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <Input
                          aria-label={`Window ${i + 1} end time`}
                          className="h-9 w-24"
                          inputMode="numeric"
                          value={r.end}
                          onChange={(event) => setEditScheduleRows((prev) => {
                            const next = [...prev];
                            next[i] = { ...next[i], end: event.target.value };
                            return next;
                          })}
                          placeholder="HH:MM"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Remove window"
                          disabled={editScheduleRows.length <= 1}
                          onClick={() => setEditScheduleRows((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={() => setEditScheduleRows((prev) => [...prev, { day_of_week: 1, start: "00:00", end: "23:59" }])}
                    >
                      <Plus /> Add window
                    </Button>
                  </div>
                )}
              </div>
              <FieldDescription>
                If enabled, this rule only applies during these windows in the agent&apos;s local time. Overnight windows are supported (e.g. 22:00 → 06:00).
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={saveRule} disabled={editSaving}>
              {editSaving && <Spinner />} {modalMode === "create" ? "Add rule" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteRule !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteRule(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete block rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete block rule <strong className="text-foreground">{deleteRule?.name || deleteRule?.exe_pattern}</strong>? This cannot be undone.
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

      {/* History dialog */}
      <Dialog open={historyRule !== null} onOpenChange={(open) => { if (!open) setHistoryRule(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Kill history — {historyRule?.name || historyRule?.exe_pattern}</DialogTitle>
          </DialogHeader>
          {historyLoading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : historyEvents.length === 0 ? (
            <Empty className="bg-muted/50">
              <EmptyHeader>
                <EmptyTitle>No kills recorded yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl bg-muted/50">
              <Table>
                <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-44">Time</TableHead>
                    <TableHead className="w-44">Agent</TableHead>
                    <TableHead>EXE</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                  {historyEvents.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs tabular-nums">{fmtDateTime(row.killed_at)}</TableCell>
                      <TableCell>{row.agent_name}</TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{row.exe_name}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryRule(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
