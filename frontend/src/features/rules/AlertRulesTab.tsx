import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, Eye, History, Pencil, Plus, Search, Trash2, X } from "lucide-react";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, errorText } from "@/api";
import { fmtDateTime } from "@/lib/utils";
import type { Agent, AgentGroup, AlertRule, AlertRuleChannel, AlertRuleComparator, AlertRuleMatchMode, AlertRuleMetric, AlertRuleScope, AlertRuleScopeKind } from "@/api/types";
import { emptyScopeRow, formScopesToApi, scopeBadge, scopesToForm, type ScopeFormRow } from "./rulesUtils";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";

const CHANNEL_OPTIONS = [
  { label: "URL", value: "url" },
  { label: "URL category", value: "url_category" },
  { label: "Keystrokes", value: "keys" },
  { label: "Resource threshold", value: "resource" },
  { label: "Agent offline", value: "agent_offline" },
];
const MATCH_OPTIONS = [
  { value: "substring", label: "Substring" },
  { value: "regex", label: "Regex" },
];
const METRIC_OPTIONS = [
  { label: "CPU usage", value: "cpu_pct" },
  { label: "Memory usage", value: "mem_pct" },
  { label: "Disk usage", value: "disk_pct" },
];
const COMPARATOR_OPTIONS = [
  { value: "gt", label: "Above" },
  { value: "lt", label: "Below" },
];
const CHANNEL_LABEL: Record<string, string> = {
  url: "URL",
  url_category: "URL category",
  keys: "Keystrokes",
  resource: "Resource threshold",
  agent_offline: "Agent offline",
};
const METRIC_LABEL: Record<string, string> = { cpu_pct: "CPU", mem_pct: "Memory", disk_pct: "Disk" };

const isMonitoringChannel = (c: AlertRuleChannel) => c === "resource" || c === "agent_offline";

/** Short human summary of what a rule matches (for the list table). */
function ruleSummary(r: AlertRule): string {
  if (r.channel === "resource") {
    return `${METRIC_LABEL[r.metric ?? "cpu_pct"] ?? r.metric} ${r.comparator === "lt" ? "<" : ">"} ${r.threshold ?? 0}%`;
  }
  if (r.channel === "agent_offline") {
    return `Offline ≥ ${Math.round((r.duration_secs ?? 300) / 60)}m`;
  }
  return r.pattern;
}
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
  // Monitoring channels.
  metric: AlertRuleMetric;
  comparator: AlertRuleComparator;
  threshold: number;
  duration_mins: number;
  scopes: ScopeFormRow[];
}

function defaultForm(): AlertRuleForm {
  return { name: "", channel: "url", pattern: "", match_mode: "substring", case_insensitive: true, cooldown_secs: 300, enabled: true, take_screenshot: false, metric: "cpu_pct", comparator: "gt", threshold: 90, duration_mins: 5, scopes: [emptyScopeRow()] };
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

const PAGE_SIZE = 50;

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

export function AlertRulesTab({ groups, agents }: AlertRulesTabProps) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

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
    } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setRuleForm(defaultForm()); setRuleModal({ mode: "create" }); };
  const openEdit = (r: AlertRule) => { setRuleForm({ name: r.name, channel: r.channel, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, enabled: r.enabled, take_screenshot: Boolean(r.take_screenshot), metric: r.metric ?? "cpu_pct", comparator: r.comparator ?? "gt", threshold: r.threshold ?? 90, duration_mins: Math.max(1, Math.round((r.duration_secs ?? 300) / 60)), scopes: scopesToForm(r.scopes ?? []) }); setRuleModal({ mode: "edit", rule: r }); };

  const toggleEnabled = (r: AlertRule) => {
    void api.alertRulesUpdate(r.id, { name: r.name, channel: r.channel, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, enabled: !r.enabled, take_screenshot: r.take_screenshot, metric: r.metric, comparator: r.comparator, threshold: r.threshold, duration_secs: r.duration_secs, scopes: (r.scopes ?? []).map((s: AlertRuleScope) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })) }).then(load).catch((e) => setError(errorText(e)));
  };

  const saveRule = async () => {
    if (!ruleModal) return;
    const monitoring = isMonitoringChannel(ruleForm.channel);
    const pattern = ruleForm.pattern.trim();
    if (!monitoring && !pattern) { setError("Pattern is required"); return; }
    setSaving(true); setError(null);
    try {
      const body = {
        name: ruleForm.name.trim(),
        channel: ruleForm.channel,
        pattern: monitoring ? "" : pattern,
        match_mode: ruleForm.match_mode,
        case_insensitive: ruleForm.case_insensitive,
        cooldown_secs: ruleForm.cooldown_secs,
        enabled: ruleForm.enabled,
        take_screenshot: ruleForm.channel === "agent_offline" ? false : ruleForm.take_screenshot,
        metric: ruleForm.channel === "resource" ? ruleForm.metric : null,
        comparator: ruleForm.channel === "resource" ? ruleForm.comparator : null,
        threshold: ruleForm.channel === "resource" ? ruleForm.threshold : null,
        duration_secs: ruleForm.channel === "agent_offline" ? Math.max(0, Math.round(ruleForm.duration_mins * 60)) : null,
        scopes: formScopesToApi(ruleForm.scopes).map((s) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })),
      };
      if (ruleModal.mode === "create") await api.alertRulesCreate(body);
      else await api.alertRulesUpdate(ruleModal.rule.id, body);
      setRuleModal(null);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  };

  const confirmDelete = async () => {
    if (!deleteRule) return;
    setDeleting(true);
    try {
      await api.alertRulesDelete(deleteRule.id);
      setDeleteRule(null);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setDeleting(false); }
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
    } catch (e) { setError(errorText(e)); }
    finally { setHistoryLoading(false); }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) => r.name.toLowerCase().includes(q) || r.pattern.toLowerCase().includes(q));
  }, [rules, query]);
  const pagesCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pagesCount);
  const displayed = useMemo(
    () => filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filtered, activePage],
  );

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
            aria-label="Search alert rules"
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
            <EmptyTitle>{query ? "No rules match" : "No alert rules yet"}</EmptyTitle>
            <EmptyDescription>
              {query
                ? "No rules match the current search."
                : "Create one to start monitoring URLs or keystrokes."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5!">Name</TableHead>
                <TableHead className="w-32">Channel</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="w-20">Active</TableHead>
                <TableHead className="w-24 pr-5! text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {displayed.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5! font-medium">
                    {r.name || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <span className={r.channel === "url" || r.channel === "url_category" ? "text-info" : "text-muted-foreground"}>
                      {CHANNEL_LABEL[r.channel] ?? r.channel}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64">
                    <span className="block truncate font-mono text-xs">{ruleSummary(r)}</span>
                  </TableCell>
                  <TableCell>{scopeBadge(r.scopes, groups, agentsById)}</TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`${r.enabled ? "Disable" : "Enable"} rule ${r.name || r.pattern}`}
                      checked={r.enabled}
                      onCheckedChange={() => toggleEnabled(r)}
                    />
                  </TableCell>
                  <TableCell className="pr-5!">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name || r.pattern}`} />}>
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => void openHistory(r)}>
                            <History /> Event history
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

      {/* Create/edit dialog */}
      <Dialog open={ruleModal !== null} onOpenChange={(open) => { if (!open) { setRuleModal(null); setError(null); } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{ruleModal?.mode === "create" ? "New alert rule" : "Edit alert rule"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="alert-rule-name">Name (optional)</FieldLabel>
                <Input
                  id="alert-rule-name"
                  className="h-9"
                  value={ruleForm.name}
                  onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })}
                  placeholder="e.g. High CPU"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="alert-rule-channel">Channel</FieldLabel>
                <FormSelect
                  ariaLabel="Channel"
                  value={ruleForm.channel}
                  options={CHANNEL_OPTIONS}
                  onChange={(value) => setRuleForm({ ...ruleForm, channel: value as AlertRuleChannel })}
                />
              </Field>
            </div>

            {!isMonitoringChannel(ruleForm.channel) && (
              <>
                <Field>
                  <FieldLabel htmlFor="alert-rule-pattern">Pattern</FieldLabel>
                  <Input
                    id="alert-rule-pattern"
                    className="h-9"
                    value={ruleForm.pattern}
                    onChange={(event) => setRuleForm({ ...ruleForm, pattern: event.target.value })}
                    placeholder={ruleForm.channel === "url" ? "e.g. youtube.com" : ruleForm.channel === "url_category" ? "e.g. adult" : "e.g. password"}
                  />
                  <FieldDescription>
                    {ruleForm.match_mode === "regex" ? "ECMAScript regular expression." : "Case-insensitive substring to match against."}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Match mode</FieldLabel>
                  <ToggleGroup
                    size="sm"
                    spacing={0}
                    className="rounded-lg bg-muted/70 p-0.5"
                    aria-label="Match mode"
                    value={[ruleForm.match_mode]}
                    onValueChange={(value) => {
                      const next = value[0] as AlertRuleMatchMode | undefined;
                      if (next) setRuleForm({ ...ruleForm, match_mode: next });
                    }}
                  >
                    {MATCH_OPTIONS.map((o) => (
                      <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} className="rounded-md! px-3 aria-pressed:bg-background">
                        {o.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              </>
            )}

            {ruleForm.channel === "resource" && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>Metric</FieldLabel>
                    <FormSelect
                      ariaLabel="Metric"
                      value={ruleForm.metric}
                      options={METRIC_OPTIONS}
                      onChange={(value) => setRuleForm({ ...ruleForm, metric: value as AlertRuleMetric })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Condition</FieldLabel>
                    <ToggleGroup
                      size="sm"
                      spacing={0}
                      className="rounded-lg bg-muted/70 p-0.5"
                      aria-label="Condition"
                      value={[ruleForm.comparator]}
                      onValueChange={(value) => {
                        const next = value[0] as AlertRuleComparator | undefined;
                        if (next) setRuleForm({ ...ruleForm, comparator: next });
                      }}
                    >
                      {COMPARATOR_OPTIONS.map((o) => (
                        <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} className="rounded-md! px-3 aria-pressed:bg-background">
                          {o.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="alert-rule-threshold">Threshold (%)</FieldLabel>
                  <Input
                    id="alert-rule-threshold"
                    className="h-9"
                    type="number"
                    value={String(ruleForm.threshold)}
                    onChange={(event) => setRuleForm({ ...ruleForm, threshold: Math.min(100, Math.max(0, parseInt(event.target.value, 10) || 0)) })}
                  />
                  <FieldDescription>Alert when the metric crosses this percentage.</FieldDescription>
                </Field>
              </>
            )}

            {ruleForm.channel === "agent_offline" && (
              <Field>
                <FieldLabel htmlFor="alert-rule-duration">Offline for (minutes)</FieldLabel>
                <Input
                  id="alert-rule-duration"
                  className="h-9"
                  type="number"
                  value={String(ruleForm.duration_mins)}
                  onChange={(event) => setRuleForm({ ...ruleForm, duration_mins: Math.max(1, parseInt(event.target.value, 10) || 1) })}
                />
                <FieldDescription>Fire when the agent has had no contact for at least this long.</FieldDescription>
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="alert-rule-cooldown">Cooldown (seconds)</FieldLabel>
              <Input
                id="alert-rule-cooldown"
                className="h-9"
                type="number"
                value={String(ruleForm.cooldown_secs)}
                onChange={(event) => setRuleForm({ ...ruleForm, cooldown_secs: Math.max(0, parseInt(event.target.value, 10) || 0) })}
              />
              <FieldDescription>Minimum seconds between repeated alerts for the same agent.</FieldDescription>
            </Field>

            <div className="flex flex-col gap-3">
              {!isMonitoringChannel(ruleForm.channel) && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={ruleForm.case_insensitive} onCheckedChange={(checked) => setRuleForm({ ...ruleForm, case_insensitive: checked === true })} />
                  Case insensitive
                </label>
              )}
              {ruleForm.channel !== "agent_offline" && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={ruleForm.take_screenshot} onCheckedChange={(checked) => setRuleForm({ ...ruleForm, take_screenshot: checked === true })} />
                  Take screenshot on trigger
                </label>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={ruleForm.enabled} onCheckedChange={(checked) => setRuleForm({ ...ruleForm, enabled: checked === true })} />
                Enabled
              </label>
            </div>

            <Field>
              <FieldLabel>Scope</FieldLabel>
              <div className="flex flex-col gap-3">
                {ruleForm.scopes.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3">
                    <div className="min-w-36 flex-1">
                      <FormSelect
                        ariaLabel={`Scope ${i + 1} kind`}
                        value={s.kind}
                        options={SCOPE_OPTIONS}
                        onChange={(value) => updateScope(i, { kind: value as AlertRuleScopeKind })}
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
                    {ruleForm.scopes.length > 1 && (
                      <Button variant="ghost" size="sm" aria-label={`Remove scope ${i + 1}`} onClick={() => setRuleForm({ ...ruleForm, scopes: ruleForm.scopes.filter((_, j) => j !== i) })}>
                        <X /> Remove
                      </Button>
                    )}
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setRuleForm({ ...ruleForm, scopes: [...ruleForm.scopes, emptyScopeRow()] })}>
                  <Plus /> Add scope
                </Button>
              </div>
              <FieldDescription>Which agents this rule monitors.</FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRuleModal(null); setError(null); }}>
              Cancel
            </Button>
            <Button onClick={() => void saveRule()} disabled={saving}>
              {saving && <Spinner />} Save
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
              Delete rule <strong className="text-foreground">{deleteRule?.name || deleteRule?.pattern}</strong>? This cannot be undone.
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

      {/* History dialog */}
      <Dialog open={historyRule !== null} onOpenChange={(open) => { if (!open) setHistoryRule(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>History — {historyRule?.name || historyRule?.pattern}</DialogTitle>
          </DialogHeader>
          {historyLoading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : historyEvents.length === 0 ? (
            <Empty className="bg-muted/50">
              <EmptyHeader>
                <EmptyTitle>No events yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl bg-muted/50">
              <Table>
                <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-44">Time</TableHead>
                    <TableHead className="w-44">Agent</TableHead>
                    <TableHead>Matched</TableHead>
                    <TableHead className="w-28 text-right">Screenshot</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                  {historyEvents.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs tabular-nums">{fmtDateTime(row.created_at)}</TableCell>
                      <TableCell>{row.agent_name}</TableCell>
                      <TableCell className="max-w-72">
                        <span className="block truncate font-mono text-xs">{row.snippet || "—"}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {row.has_screenshot
                          ? <Button variant="ghost" size="sm" onClick={() => setPreviewEventId(row.id)}><Eye /> View</Button>
                          : <span className="text-xs text-muted-foreground">—</span>}
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

      <ScreenshotDialog eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </div>
  );
}
