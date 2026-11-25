import { RuleListState } from "./components/RuleListState";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { ListPagination } from "@/components/common/ListPagination";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vantyr/ui/components/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
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
  const rulesQuery = useQuery({
    ...ruleQueries.internetBlockRules(),
    select: toRules,
  });
  const rules = rulesQuery.data ?? NO_RULES;
  const loading = rulesQuery.isFetching;
  // Validation and mutation failures; a failed list load comes from the query.
  const [localError, setLocalError] = useState<string | null>(null);
  const error =
    localError ?? (rulesQuery.error ? errorText(rulesQuery.error) : null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editScheduleFor, setEditScheduleFor] =
    useState<InternetBlockRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<InternetBlockRule | null>(null);

  const listKey = ruleQueries.internetBlockRules().queryKey;
  const refreshRules = () =>
    queryClient.invalidateQueries({ queryKey: ruleKeys.internetBlockRules() });

  const create = useMutation({
    mutationFn: (body: InternetBlockRuleBody) =>
      api.internetBlockRulesCreate(body),
    onSuccess: async () => {
      setShowCreate(false);
      await refreshRules();
    },
    onError: (e) => setLocalError(errorText(e)),
  });

  const toggle = useMutation({
    mutationFn: (r: InternetBlockRule) =>
      api.internetBlockRulesUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: (_, r) =>
      queryClient.setQueryData(
        listKey,
        (prev) =>
          prev && {
            ...prev,
            rules: prev.rules.map((x) =>
              x.id === r.id ? { ...x, enabled: !x.enabled } : x,
            ),
          },
      ),
    onError: (e) => setLocalError(errorText(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.id : null;

  const remove = useMutation({
    mutationFn: (r: InternetBlockRule) => api.internetBlockRulesDelete(r.id),
    onSuccess: (_, r) => {
      queryClient.setQueryData(
        listKey,
        (prev) =>
          prev && { ...prev, rules: prev.rules.filter((x) => x.id !== r.id) },
      );
      setDeleteRule(null);
    },
    onError: (e) => setLocalError(errorText(e)),
  });
  const deleting = remove.isPending;

  const scheduleSave = useMutation({
    mutationFn: ({
      rule,
      schedules,
    }: {
      rule: InternetBlockRule;
      schedules: ScheduleWindow[];
    }) =>
      api.internetBlockRulesUpdate(rule.id, {
        enabled: rule.enabled,
        schedules,
      }),
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
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  setPage(1);
                }}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Button onClick={() => setShowCreate(true)}>
          <Plus /> New rule
        </Button>
      </div>

      <RuleListState
        loading={loading && rules.length === 0}
        empty={displayed.length === 0}
        searching={Boolean(query)}
        emptyTitle="No internet block rules"
        emptyDescription="Create one to restrict internet access for all devices, a group, or a specific device."
        noun="rules"
      >
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
                <InternetBlockRow
                  key={r.id}
                  r={r}
                  groups={groups}
                  agents={agents}
                  togglingId={togglingId}
                  toggleRule={toggleRule}
                  setEditScheduleFor={setEditScheduleFor}
                  setDeleteRule={setDeleteRule}
                />
              ))}
            </TableBody>
          </Table>
          {/* The list itself shows how many rules there are; only paging needs a footer. */}
          <ListPagination
            page={activePage}
            pages={pagesCount}
            onPageChange={setPage}
          />
        </div>
      </RuleListState>

      <InternetBlockRuleDialog
        open={showCreate}
        groups={groups}
        agents={agents}
        saving={create.isPending}
        onSave={(body) => {
          setLocalError(null);
          create.mutate(body);
        }}
        onClose={() => setShowCreate(false)}
      />

      <InternetScheduleDialog
        rule={editScheduleFor}
        saving={scheduleSave.isPending}
        onSave={(rule, schedules) => scheduleSave.mutate({ rule, schedules })}
        onClose={() => setEditScheduleFor(null)}
      />

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={deleteRule !== null}
        pending={deleting}
        title="Delete rule?"
        onClose={() => setDeleteRule(null)}
        onConfirm={confirmDelete}
      >
        Delete rule{" "}
        <strong className="text-foreground">
          {deleteRule?.name || "Internet block"}
        </strong>
        ? This cannot be undone.
      </ConfirmDeleteDialog>
    </div>
  );
}

function InternetBlockRow({
  r,
  groups,
  agents,
  togglingId,
  toggleRule,
  setEditScheduleFor,
  setDeleteRule,
}: {
  r: InternetBlockRule;
  groups: AgentGroup[];
  agents: Agent[];
  togglingId: number | null;
  toggleRule: (rule: InternetBlockRule) => void;
  setEditScheduleFor: (rule: InternetBlockRule) => void;
  setDeleteRule: (rule: InternetBlockRule) => void;
}) {
  return (
    <TableRow>
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
      <TableCell className="font-mono text-xs tabular-nums">
        {fmtDateTime(r.created_at)}
      </TableCell>
      <TableCell className="pr-5!">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${r.name || "Internet block"}`}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditScheduleFor(r)}>
                <Pencil /> Edit schedule
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteRule(r)}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}
