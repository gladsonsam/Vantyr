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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorText } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import type { Agent, AgentGroup, AlertRule, AlertRuleScope } from "@/api/types";
import { scopeBadge } from "./rulesUtils";
import { AlertRuleDialog, type AlertRuleDialogTarget } from "./components/AlertRuleDialog";
import { AlertRuleHistoryDialog } from "./components/AlertRuleHistoryDialog";
import { useAlertRuleHistory } from "./hooks/useAlertRuleHistory";
import type { AlertRuleBody } from "./lib/alertRuleForm";

const CHANNEL_LABEL: Record<string, string> = {
  url: "URL",
  url_category: "URL category",
  keys: "Keystrokes",
  resource: "Resource threshold",
  agent_offline: "Agent offline",
};
const METRIC_LABEL: Record<string, string> = { cpu_pct: "CPU", mem_pct: "Memory", disk_pct: "Disk" };

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

const NO_RULES: AlertRule[] = [];

const toRules = (d: { rules: AlertRule[] }) => d.rules ?? NO_RULES;

interface AlertRulesTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

export function AlertRulesTab({ groups, agents }: AlertRulesTabProps) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ ...ruleQueries.alertRules(), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;
  const loading = rulesQuery.isFetching;
  // Validation and mutation failures; list/history load failures come from their queries.
  const [localError, setLocalError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const [ruleDialog, setRuleDialog] = useState<AlertRuleDialogTarget>(null);
  const [deleteRule, setDeleteRule] = useState<AlertRule | null>(null);
  const [historyRule, setHistoryRule] = useState<AlertRule | null>(null);
  const history = useAlertRuleHistory(historyRule?.id ?? null);

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);

  const error = localError
    ?? (rulesQuery.error ? errorText(rulesQuery.error) : history.error ? errorText(history.error) : null);

  const refreshRules = () => queryClient.invalidateQueries({ queryKey: ruleKeys.alertRules() });

  const toggle = useMutation({
    mutationFn: (r: AlertRule) => api.alertRulesUpdate(r.id, { name: r.name, channel: r.channel, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, enabled: !r.enabled, take_screenshot: r.take_screenshot, metric: r.metric, comparator: r.comparator, threshold: r.threshold, duration_secs: r.duration_secs, scopes: (r.scopes ?? []).map((s: AlertRuleScope) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })) }),
    onSuccess: () => refreshRules(),
    onError: (e) => setLocalError(errorText(e)),
  });

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: AlertRuleBody }) => {
      if (id === null) await api.alertRulesCreate(body);
      else await api.alertRulesUpdate(id, body);
    },
    onSuccess: async () => {
      setRuleDialog(null);
      await refreshRules();
    },
    onError: (e) => setLocalError(errorText(e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.alertRulesDelete(id),
    onSuccess: async () => {
      setDeleteRule(null);
      await refreshRules();
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const deleting = remove.isPending;

  const closeRuleDialog = () => { setRuleDialog(null); setLocalError(null); };

  const toggleEnabled = (r: AlertRule) => toggle.mutate(r);

  const confirmDelete = () => {
    if (!deleteRule) return;
    remove.mutate(deleteRule.id);
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
        <Button onClick={() => setRuleDialog({ mode: "create" })}>
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
                          <DropdownMenuItem onClick={() => setHistoryRule(r)}>
                            <History /> Event history
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setRuleDialog({ mode: "edit", rule: r })}>
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


      <AlertRuleDialog
        target={ruleDialog}
        groups={groups}
        agents={agents}
        saving={save.isPending}
        onSave={(id, body) => save.mutate({ id, body })}
        onValidationError={setLocalError}
        onClose={closeRuleDialog}
      />


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
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={confirmDelete}>
              {deleting && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


      <AlertRuleHistoryDialog rule={historyRule} events={history.events} loading={history.loading} onClose={() => setHistoryRule(null)} />
    </div>
  );
}
