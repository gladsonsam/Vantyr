import { RuleListState } from "./components/RuleListState";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { ListPagination } from "@/components/common/ListPagination";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MoreHorizontal,
  History,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
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
import { AppIcon } from "@/components/common/AppIcon";
import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";
import { appBlockScopeBadge, scheduleSummary } from "./rulesUtils";
import { AppBlockHistoryDialog } from "./components/AppBlockHistoryDialog";
import {
  AppBlockRuleDialog,
  type AppBlockRuleDialogTarget,
} from "./components/AppBlockRuleDialog";
import type { AppBlockRuleBody } from "./lib/appBlockForm";

interface AppBlockingTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

const NO_RULES: AppBlockRule[] = [];

const toRules = (d: { rules: AppBlockRule[] }) => d.rules ?? NO_RULES;

export function AppBlockingTab({ groups, agents }: AppBlockingTabProps) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({
    ...ruleQueries.appBlockRules(),
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
  const [ruleDialog, setRuleDialog] = useState<AppBlockRuleDialogTarget>(null);
  const [historyRule, setHistoryRule] = useState<AppBlockRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<AppBlockRule | null>(null);

  const openHistory = (r: AppBlockRule) => setHistoryRule(r);

  const listKey = ruleQueries.appBlockRules().queryKey;

  const toggle = useMutation({
    mutationFn: (r: AppBlockRule) =>
      api.appBlockRulesUpdate(r.id, { enabled: !r.enabled }),
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
    mutationFn: (r: AppBlockRule) => api.appBlockRulesDelete(r.id),
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

  const save = useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: number | null;
      body: AppBlockRuleBody;
    }) => {
      if (id === null) await api.appBlockRulesCreate(body);
      else await api.appBlockRulesUpdate(id, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ruleKeys.appBlockRules(),
      });
      setRuleDialog(null);
    },
    onError: (e) => setLocalError(errorText(e)),
  });

  const toggleRule = (r: AppBlockRule) => toggle.mutate(r);

  const confirmDelete = () => {
    if (!deleteRule) return;
    remove.mutate(deleteRule);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.exe_pattern.toLowerCase().includes(q) ||
        (r.name || "").toLowerCase().includes(q),
    );
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
        <Button onClick={() => setRuleDialog({ mode: "create" })}>
          <Plus /> New rule
        </Button>
      </div>

      <RuleListState
        loading={loading && rules.length === 0}
        empty={displayed.length === 0}
        searching={Boolean(query)}
        emptyTitle="No app block rules yet"
        emptyDescription="Create one to block apps on managed devices."
        noun="rules"
      >
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
                <AppBlockRow
                  key={r.id}
                  r={r}
                  contextAgentId={contextAgentId}
                  groups={groups}
                  agentsById={agentsById}
                  togglingId={togglingId}
                  toggleRule={toggleRule}
                  setRuleDialog={setRuleDialog}
                  openHistory={openHistory}
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

      <AppBlockRuleDialog
        target={ruleDialog}
        groups={groups}
        agents={agents}
        contextAgentId={contextAgentId}
        saving={save.isPending}
        onSave={(id, body) => {
          setLocalError(null);
          save.mutate({ id, body });
        }}
        onClose={() => setRuleDialog(null)}
      />

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={deleteRule !== null}
        pending={deleting}
        title="Delete block rule?"
        onClose={() => setDeleteRule(null)}
        onConfirm={confirmDelete}
      >
        Delete block rule{" "}
        <strong className="text-foreground">
          {deleteRule?.name || deleteRule?.exe_pattern}
        </strong>
        ? This cannot be undone.
      </ConfirmDeleteDialog>

      <AppBlockHistoryDialog
        rule={historyRule}
        onClose={() => setHistoryRule(null)}
      />
    </div>
  );
}

function AppBlockRow({
  r,
  contextAgentId,
  groups,
  agentsById,
  togglingId,
  toggleRule,
  setRuleDialog,
  openHistory,
  setDeleteRule,
}: {
  r: AppBlockRule;
  contextAgentId: string;
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  togglingId: number | null;
  toggleRule: (rule: AppBlockRule) => void;
  setRuleDialog: (target: NonNullable<AppBlockRuleDialogTarget>) => void;
  openHistory: (rule: AppBlockRule) => void;
  setDeleteRule: (rule: AppBlockRule) => void;
}) {
  return (
    <TableRow>
      <TableCell className="pl-5!">
        <div className="flex items-center gap-2">
          {contextAgentId && (
            <AppIcon
              agentId={contextAgentId}
              exeName={r.exe_pattern}
              size={18}
            />
          )}
          <span className="font-mono text-xs">{r.exe_pattern}</span>
          <span className="text-xs text-muted-foreground">{r.match_mode}</span>
        </div>
      </TableCell>
      <TableCell>
        {r.name || <span className="text-muted-foreground">—</span>}
      </TableCell>
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
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${r.name || r.exe_pattern}`}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setRuleDialog({ mode: "edit", rule: r })}
              >
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openHistory(r)}>
                <History /> Kill history
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
