import { RuleListState } from "./components/RuleListState";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { ListPagination } from "@/components/common/ListPagination";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MoreHorizontal,
  Pencil,
  Play,
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
import type { Agent, AgentGroup, ScheduledScript } from "@/api/types";
import { inetScopeBadge, scheduledScriptScheduleSummary } from "./rulesUtils";
import {
  ScheduledScriptDialog,
  type ScheduledScriptDialogTarget,
} from "./components/ScheduledScriptDialog";
import { ScriptLastRun } from "./components/ScriptLastRun";
import { useScheduledScriptRuns } from "./hooks/useScheduledScriptRuns";
import type { ScheduledScriptBody } from "./lib/scheduledScriptForm";

interface ScheduledScriptsTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const PAGE_SIZE = 50;

const NO_SCRIPTS: ScheduledScript[] = [];

const toScripts = (d: { scripts: ScheduledScript[] }) =>
  d.scripts ?? NO_SCRIPTS;

export function ScheduledScriptsTab({
  groups,
  agents,
}: ScheduledScriptsTabProps) {
  const queryClient = useQueryClient();
  const scriptsQuery = useQuery({
    ...ruleQueries.scheduledScripts(),
    select: toScripts,
  });
  const rules = scriptsQuery.data ?? NO_SCRIPTS;
  const runs = useScheduledScriptRuns();
  const lastRuns = runs.lastRuns;
  const loading = scriptsQuery.isFetching || runs.isFetching;
  // Validation and mutation failures; a failed list load comes from the query.
  const [localError, setLocalError] = useState<string | null>(null);
  const error =
    localError ?? (scriptsQuery.error ? errorText(scriptsQuery.error) : null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [scriptDialog, setScriptDialog] =
    useState<ScheduledScriptDialogTarget>(null);
  const [deleteRule, setDeleteRule] = useState<ScheduledScript | null>(null);

  // Scripts and their run feed share the `scheduledScripts` key prefix, so this reloads both.
  const refreshScripts = () =>
    queryClient.invalidateQueries({ queryKey: ruleKeys.scheduledScripts() });

  const save = useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: number | null;
      body: ScheduledScriptBody;
    }) => {
      if (id === null) await api.scheduledScriptsCreate(body);
      else await api.scheduledScriptsUpdate(id, body);
    },
    onSuccess: async () => {
      setScriptDialog(null);
      await refreshScripts();
    },
    onError: (e) => setLocalError(errorText(e)),
  });

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
    mutationFn: (r: ScheduledScript) =>
      api.scheduledScriptsUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: () => refreshScripts(),
    onError: (e) => setLocalError(errorText(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.id : null;

  const trigger = useMutation({
    mutationFn: (r: ScheduledScript) => api.scheduledScriptsTrigger(r.id),
    onSuccess: async (_, r) => {
      setSuccessMsg(
        `Script "${r.name}" enqueued for immediate execution on target agents.`,
      );
      setTimeout(() => setSuccessMsg(null), 4000);
      await refreshScripts();
    },
    onError: (e) => setLocalError(errorText(e)),
  });

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
          <AlertDescription className="text-success">
            {successMsg}
          </AlertDescription>
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
        <Button onClick={() => setScriptDialog({ mode: "create" })}>
          <Plus /> New script
        </Button>
      </div>

      <RuleListState
        loading={loading && rules.length === 0}
        empty={displayed.length === 0}
        searching={Boolean(query)}
        emptyTitle="No scheduled scripts yet"
        emptyDescription="Create one to run diagnostic/monitoring scripts periodically."
        noun="scripts"
      >
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
                  <ScheduledScriptRow
                    key={r.id}
                    r={r}
                    run={run}
                    groups={groups}
                    agents={agents}
                    togglingId={togglingId}
                    toggleRule={toggleRule}
                    runScriptNow={runScriptNow}
                    setScriptDialog={setScriptDialog}
                    setDeleteRule={setDeleteRule}
                  />
                );
              })}
            </TableBody>
          </Table>
          <ListPagination
            page={activePage}
            pages={pagesCount}
            onPageChange={setPage}
            count={filtered.length}
            item="script"
          />
        </div>
      </RuleListState>

      <ScheduledScriptDialog
        target={scriptDialog}
        groups={groups}
        agents={agents}
        saving={save.isPending}
        onSave={(id, body) => {
          setLocalError(null);
          save.mutate({ id, body });
        }}
        onClose={() => setScriptDialog(null)}
      />

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={deleteRule !== null}
        pending={deleting}
        title="Delete scheduled script?"
        onClose={() => setDeleteRule(null)}
        onConfirm={confirmDelete}
      >
        Delete scheduled script{" "}
        <strong className="text-foreground">{deleteRule?.name}</strong>? This
        cannot be undone.
      </ConfirmDeleteDialog>
    </div>
  );
}

function ScheduledScriptRow({
  r,
  run,
  groups,
  agents,
  togglingId,
  toggleRule,
  runScriptNow,
  setScriptDialog,
  setDeleteRule,
}: {
  r: ScheduledScript;
  run: Parameters<typeof ScriptLastRun>[0]["run"];
  groups: AgentGroup[];
  agents: Agent[];
  togglingId: number | null;
  toggleRule: (rule: ScheduledScript) => void;
  runScriptNow: (rule: ScheduledScript) => void;
  setScriptDialog: (target: NonNullable<ScheduledScriptDialogTarget>) => void;
  setDeleteRule: (rule: ScheduledScript) => void;
}) {
  return (
    <TableRow>
      <TableCell className="pl-5! font-medium">
        {r.name || <span className="text-muted-foreground">Unnamed</span>}
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs text-muted-foreground">
          {r.shell}
        </span>
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
        <ScriptLastRun run={run} />
      </TableCell>
      <TableCell className="pr-5!">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${r.name}`}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => runScriptNow(r)}>
                <Play /> Run now
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setScriptDialog({ mode: "edit", script: r })}
              >
                <Pencil /> Edit
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
