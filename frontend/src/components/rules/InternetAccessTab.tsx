import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorText } from "@/lib/api";
import { fmtDateTime } from "@/lib/utils";
import type { Agent, AgentGroup, InternetBlockRule, RuleSchedule } from "@/lib/types";
import { emptyScopeRow, inetScopeBadge, timeToMinute, minuteToTime, scheduleSummary, type ScopeFormRow } from "./rulesUtils";

type InetScheduleFormRow = { day_of_week: number; start: string; end: string };

function emptyInetSchedule(): InetScheduleFormRow { return { day_of_week: 1, start: "00:00", end: "23:59" }; }

interface InternetAccessTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

const SCOPE_OPTS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

function FormSelect({ value, options, onChange, placeholder, ariaLabel }: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(next: string | null) => { if (next !== null) onChange(next); }}>
      <SelectTrigger aria-label={ariaLabel} className="h-9 w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function expandScheduleRows(rows: InetScheduleFormRow[]) {
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
}

function ScheduleRowsEditor({ rows, onChange }: {
  rows: InetScheduleFormRow[];
  onChange: (rows: InetScheduleFormRow[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
          <div className="min-w-32 flex-1">
            <FormSelect
              ariaLabel={`Window ${i + 1} day`}
              value={String(r.day_of_week)}
              options={DAY_OPTIONS}
              onChange={(value) => {
                const next = [...rows];
                next[i] = { ...next[i], day_of_week: Number(value) };
                onChange(next);
              }}
            />
          </div>
          <Input
            aria-label={`Window ${i + 1} start time`}
            className="h-9 w-24"
            inputMode="numeric"
            value={r.start}
            onChange={(event) => {
              const next = [...rows];
              next[i] = { ...next[i], start: event.target.value };
              onChange(next);
            }}
            placeholder="HH:MM"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            aria-label={`Window ${i + 1} end time`}
            className="h-9 w-24"
            inputMode="numeric"
            value={r.end}
            onChange={(event) => {
              const next = [...rows];
              next[i] = { ...next[i], end: event.target.value };
              onChange(next);
            }}
            placeholder="HH:MM"
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Remove window"
            disabled={rows.length <= 1}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rows, emptyInetSchedule()])}>
        <Plus /> Add window
      </Button>
    </div>
  );
}

export function InternetAccessTab({ groups, agents }: InternetAccessTabProps) {
  const [rules, setRules] = useState<InternetBlockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
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
  const [deleteRule, setDeleteRule] = useState<InternetBlockRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

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

  const confirmDelete = async () => {
    if (!deleteRule) return;
    setDeleting(true);
    try {
      await api.internetBlockRulesDelete(deleteRule.id);
      setRules((prev) => prev.filter((x) => x.id !== deleteRule.id));
      setDeleteRule(null);
    } catch (e) { setError(errorText(e)); }
    finally { setDeleting(false); }
  };

  const saveSchedule = () => {
    const r = editScheduleFor;
    if (!r) return;
    const schedules = expandScheduleRows(editSchedules);
    setEditSaving(true);
    api.internetBlockRulesUpdate(r.id, { enabled: r.enabled, schedules })
      .then(() => load())
      .then(() => setEditScheduleFor(null))
      .catch((e) => setError(errorText(e)))
      .finally(() => setEditSaving(false));
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

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="h-9 min-w-0 flex-1 sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search internet block rules"
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
        <Button onClick={() => setShowCreate(true)}>
          <Plus /> New rule
        </Button>
      </div>

      {loading && rules.length === 0 ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : displayed.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyTitle>{query ? "No rules match" : "No internet block rules"}</EmptyTitle>
            <EmptyDescription>
              {query
                ? "No rules match the current search."
                : "Create one to restrict internet access for all devices, a group, or a specific device."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5!">Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-44">Created</TableHead>
                <TableHead className="w-24 pr-5! text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {displayed.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5! font-medium">
                    {r.name || <span className="text-muted-foreground">Unnamed</span>}
                  </TableCell>
                  <TableCell>{inetScopeBadge(r, groups, agents)}</TableCell>
                  <TableCell>{scheduleSummary(r.schedules)}</TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`${r.enabled ? "Disable" : "Enable"} rule ${r.name || "Internet block"}`}
                      checked={r.enabled}
                      disabled={togglingId === r.id}
                      onCheckedChange={() => toggleRule(r)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{fmtDateTime(r.created_at)}</TableCell>
                  <TableCell className="pr-5!">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name || "Internet block"}`} />}>
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditScheduleFor(r);
                              const rows: InetScheduleFormRow[] = (r.schedules ?? []).length
                                ? (r.schedules ?? []).map((w: RuleSchedule) => ({ day_of_week: w.day_of_week, start: minuteToTime(w.start_minute), end: minuteToTime(w.end_minute) }))
                                : [emptyInetSchedule()];
                              setEditSchedules(rows);
                            }}
                          >
                            <Pencil /> Edit schedule
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

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open) setShowCreate(false); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New internet block rule</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <Field>
              <FieldLabel htmlFor="inet-name">Name (optional)</FieldLabel>
              <Input
                id="inet-name"
                className="h-9"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="e.g. Block school devices"
              />
            </Field>
            <Field>
              <FieldLabel>Scope</FieldLabel>
              <div className="flex flex-col gap-3">
                {createScopes.map((s, i) => (
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
                    {createScopes.length > 1 && (
                      <Button variant="ghost" size="sm" aria-label={`Remove scope ${i + 1}`} onClick={() => setCreateScopes((p) => p.filter((_, j) => j !== i))}>
                        <X /> Remove
                      </Button>
                    )}
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setCreateScopes((p) => [...p, emptyScopeRow()])}>
                  <Plus /> Add scope
                </Button>
              </div>
              <FieldDescription>Who this rule blocks.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Schedule (optional)</FieldLabel>
              <div className="flex flex-col gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={createScheduled} onCheckedChange={(checked) => setCreateScheduled(checked === true)} />
                  Enable schedule (curfew)
                </label>
                {createScheduled && (
                  <>
                    <ScheduleRowsEditor rows={createSchedules} onChange={setCreateSchedules} />
                    <p className="text-xs text-muted-foreground">
                      Overnight windows (e.g. 22:00 → 06:00) are supported (they’ll be split across days automatically).
                    </p>
                  </>
                )}
              </div>
              <FieldDescription>If enabled, this rule only applies during these windows in the agent’s local time.</FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => void createRule()} disabled={saving}>
              {saving && <Spinner />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit schedule dialog */}
      <Dialog open={editScheduleFor !== null} onOpenChange={(open) => { if (!open) setEditScheduleFor(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit schedule — {editScheduleFor?.name || "Internet block"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <p className="text-sm text-muted-foreground">
              Empty schedule means <strong className="text-foreground">Always</strong>. Overnight windows (22:00 → 06:00) are supported (split automatically).
            </p>
            <ScheduleRowsEditor rows={editSchedules} onChange={setEditSchedules} />
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setEditSchedules([emptyInetSchedule()])}>
              Reset to Always
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditScheduleFor(null)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={saveSchedule} disabled={editSaving}>
              {editSaving && <Spinner />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteRule !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteRule(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete rule <strong className="text-foreground">{deleteRule?.name || "Internet block"}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
