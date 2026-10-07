import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { fmtDateTime } from "@/lib/utils";
import type { Agent, AgentGroup, InternetBlockRule } from "@/api/types";
import { inetScopeBadge, scheduleSummary } from "./rulesUtils";
import { InternetBlockRuleDialog } from "./components/InternetBlockRuleDialog";
import { InternetScheduleDialog } from "./components/InternetScheduleDialog";
import type { InternetBlockRuleBody } from "./lib/internetBlockForm";
import type { ScheduleWindow } from "./lib/scheduleRows";

interface InternetAccessTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

const NO_RULES: InternetBlockRule[] = [];

const toRules = (d: { rules: InternetBlockRule[] }) => d.rules ?? NO_RULES;

export function InternetAccessTab({ groups, agents }: InternetAccessTabProps) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ ...ruleQueries.internetBlockRules(), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;
  const loading = rulesQuery.isFetching;
  // Validation and mutation failures; a failed list load comes from the query.
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? (rulesQuery.error ? errorText(rulesQuery.error) : null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editScheduleFor, setEditScheduleFor] = useState<InternetBlockRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<InternetBlockRule | null>(null);

  const listKey = ruleQueries.internetBlockRules().queryKey;
  const refreshRules = () => queryClient.invalidateQueries({ queryKey: ruleKeys.internetBlockRules() });

  const create = useMutation({
    mutationFn: (body: InternetBlockRuleBody) => api.internetBlockRulesCreate(body),
    onSuccess: async () => {
      setShowCreate(false);
      await refreshRules();
    },
    onError: (e) => setLocalError(errorText(e)),
  });

  const toggle = useMutation({
    mutationFn: (r: InternetBlockRule) => api.internetBlockRulesUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: (_, r) =>
      queryClient.setQueryData(listKey, (prev) =>
        prev && { ...prev, rules: prev.rules.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x) }),
    onError: (e) => setLocalError(errorText(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.id : null;

  const remove = useMutation({
    mutationFn: (r: InternetBlockRule) => api.internetBlockRulesDelete(r.id),
    onSuccess: (_, r) => {
      queryClient.setQueryData(listKey, (prev) => prev && { ...prev, rules: prev.rules.filter((x) => x.id !== r.id) });
      setDeleteRule(null);
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const deleting = remove.isPending;

  const scheduleSave = useMutation({
    mutationFn: ({ rule, schedules }: { rule: InternetBlockRule; schedules: ScheduleWindow[] }) =>
      api.internetBlockRulesUpdate(rule.id, { enabled: rule.enabled, schedules }),
    onSuccess: async () => {
      await refreshRules();
      setEditScheduleFor(null);
    },
    onError: (e) => setLocalError(errorText(e)),
  });

  const toggleRule = (r: InternetBlockRule) => toggle.mutate(r);

  const confirmDelete = () => {
    if (!deleteRule) return;
    remove.mutate(deleteRule);
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
                          <DropdownMenuItem onClick={() => setEditScheduleFor(r)}>
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


      <InternetBlockRuleDialog
        open={showCreate}
        groups={groups}
        agents={agents}
        saving={create.isPending}
        onSave={(body) => { setLocalError(null); create.mutate(body); }}
        onValidationError={setLocalError}
        onClose={() => setShowCreate(false)}
      />

      <InternetScheduleDialog
        rule={editScheduleFor}
        saving={scheduleSave.isPending}
        onSave={(rule, schedules) => scheduleSave.mutate({ rule, schedules })}
        onClose={() => setEditScheduleFor(null)}
      />


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
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={confirmDelete}>
              {deleting && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
