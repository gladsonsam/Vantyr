import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Plus, Search, X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { ListPagination } from "@/components/common/ListPagination";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { errorText } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import type { Agent, AgentGroup, AlertRule } from "@/api/types";
import { AlertRuleDialog, type AlertRuleDialogTarget } from "./components/AlertRuleDialog";
import { AlertRuleHistoryDialog } from "./components/AlertRuleHistoryDialog";
import { AlertRuleList, type AlertRuleAction } from "./components/AlertRuleList";
import { useAlertRuleHistory } from "./hooks/useAlertRuleHistory";
import { useAlertRuleMutations } from "./hooks/useAlertRuleMutations";
import { useAlertRuleSearch } from "./hooks/useAlertRuleSearch";
import { ruleCountSummary, ruleTitle, scopeLabels } from "./lib/alertRuleSummary";

const NO_RULES: AlertRule[] = [];

const toRules = (d: { rules: AlertRule[] }) => d.rules ?? NO_RULES;

interface AlertRulesTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

export function AlertRulesTab({ groups, agents }: AlertRulesTabProps) {
  const rulesQuery = useQuery({ ...ruleQueries.alertRules(), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;

  const [ruleDialog, setRuleDialog] = useState<AlertRuleDialogTarget>(null);
  const [deleteRule, setDeleteRule] = useState<AlertRule | null>(null);
  const [historyRule, setHistoryRule] = useState<AlertRule | null>(null);
  const history = useAlertRuleHistory(historyRule?.id ?? null);

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);

  const { toggle, save, remove, actionError, setActionError, saved, setSaved } = useAlertRuleMutations({
    onSaved: () => setRuleDialog(null),
    onDeleted: () => setDeleteRule(null),
  });
  const list = useAlertRuleSearch(rules, groups, agentsById);

  const openRuleDialog = (target: NonNullable<AlertRuleDialogTarget>) => {
    save.reset();
    setSaved(null);
    setRuleDialog(target);
  };
  const onAction = (r: AlertRule, action: AlertRuleAction) => {
    if (action === "history") setHistoryRule(r);
    else if (action === "edit") openRuleDialog({ mode: "edit", rule: r });
    else {
      remove.reset();
      setDeleteRule(r);
    }
  };
  const retry = () => void rulesQuery.refetch();

  const dialogs = (
    <AlertRuleDialogs
      groups={groups}
      agents={agents}
      agentsById={agentsById}
      ruleDialog={ruleDialog}
      saving={save.isPending}
      saveError={save.isError ? errorText(save.error) : null}
      onSave={(id, body) => save.mutate({ id, body })}
      onCloseRule={() => {
        setRuleDialog(null);
        save.reset();
      }}
      deleteRule={deleteRule}
      deleting={remove.isPending}
      deleteError={remove.isError ? errorText(remove.error) : null}
      onDelete={() => deleteRule && remove.mutate(deleteRule)}
      onCloseDelete={() => setDeleteRule(null)}
      historyRule={historyRule}
      history={history}
      onCloseHistory={() => setHistoryRule(null)}
    />
  );

  // A failed refresh keeps the rules already on screen; only a first load that failed has nothing to show.
  if (rulesQuery.isError && rules.length === 0) {
    return <LoadFailedCard message={`Couldn’t load alert rules: ${errorText(rulesQuery.error)}`} onRetry={retry} />;
  }
  if (rulesQuery.isPending) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (rules.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {saved && <Notice message={saved} onDismiss={() => setSaved(null)} />}
        <EmptyState
          title="No alert rules yet"
          description="An alert rule tells you when a device visits a site, types a phrase, runs hot or goes offline."
          icon={<BellRing />}
          iconVariant="icon"
          action={
            <Button onClick={() => openRuleDialog({ mode: "create" })}>
              <Plus /> New rule
            </Button>
          }
        />
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AlertRulesView
        rules={rules}
        list={list}
        refreshError={rulesQuery.isError ? errorText(rulesQuery.error) : null}
        actionError={actionError}
        saved={saved}
        groups={groups}
        agentsById={agentsById}
        switchesDisabled={toggle.isPending}
        onRetry={retry}
        onDismissAction={() => setActionError(null)}
        onDismissSaved={() => setSaved(null)}
        onCreate={() => openRuleDialog({ mode: "create" })}
        onToggle={(r) => {
          setActionError(null);
          setSaved(null);
          toggle.mutate(r);
        }}
        onAction={onAction}
      />
      {dialogs}
    </div>
  );
}

/** The rules that are on screen: notices, the count, search and the list itself. */
function AlertRulesView({
  rules, list, refreshError, actionError, saved, groups, agentsById, switchesDisabled,
  onRetry, onDismissAction, onDismissSaved, onCreate, onToggle, onAction,
}: {
  rules: AlertRule[];
  list: ReturnType<typeof useAlertRuleSearch>;
  /** Why the last refresh failed; the rules shown are then the last list that loaded. */
  refreshError: string | null;
  actionError: string | null;
  saved: string | null;
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  switchesDisabled: boolean;
  onRetry: () => void;
  onDismissAction: () => void;
  onDismissSaved: () => void;
  onCreate: () => void;
  onToggle: (rule: AlertRule) => void;
  onAction: (rule: AlertRule, action: AlertRuleAction) => void;
}) {
  return (
    <>
      {actionError && <ErrorBanner message={actionError} actionLabel="Dismiss" onAction={onDismissAction} />}
      {refreshError && (
        <ErrorBanner
          message={`Couldn’t refresh alert rules: ${refreshError}. Showing the last list that loaded.`}
          actionLabel="Try again"
          onAction={onRetry}
        />
      )}
      {saved && <Notice message={saved} onDismiss={onDismissSaved} />}

      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-sm text-muted-foreground tabular-nums">
          {list.query ? `${list.filteredCount} of ${rules.length} rules` : ruleCountSummary(rules)}
        </p>
        <Button onClick={onCreate}>
          <Plus /> New rule
        </Button>
      </div>
      {list.showSearch && <RuleSearch query={list.query} onChange={list.setQuery} />}

      {list.displayed.length === 0 ? (
        <EmptyState
          title="No rules match"
          description={`Nothing matches “${list.query.trim()}”.`}
          icon={<Search />}
          iconVariant="icon"
          action={
            <Button variant="outline" onClick={() => list.setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <AlertRuleList
            rules={list.displayed}
            groups={groups}
            agentsById={agentsById}
            switchesDisabled={switchesDisabled}
            onToggle={onToggle}
            onAction={onAction}
          />
          <ListPagination page={list.page} pages={list.pages} onPageChange={list.setPage} />
        </div>
      )}
    </>
  );
}

function RuleSearch({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  return (
    <InputGroup className="h-9 min-w-0 sm:max-w-md">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search alert rules"
        placeholder="Search rules…"
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

function ErrorBanner({ message, actionLabel, onAction }: { message: string; actionLabel: string; onAction: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words">{message}</span>
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <p role="status" className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">
      <span className="min-w-0 break-words">{message}</span>
      <Button variant="ghost" size="xs" aria-label="Dismiss message" onClick={onDismiss}>
        <X />
      </Button>
    </p>
  );
}

/** The edit form, the delete confirmation and the history: each reports its own failure inside itself. */
function AlertRuleDialogs({
  groups, agents, agentsById, ruleDialog, saving, saveError, onSave, onCloseRule,
  deleteRule, deleting, deleteError, onDelete, onCloseDelete, historyRule, history, onCloseHistory,
}: {
  groups: AgentGroup[];
  agents: Agent[];
  agentsById: Record<string, Agent>;
  ruleDialog: AlertRuleDialogTarget;
  saving: boolean;
  saveError: string | null;
  onSave: React.ComponentProps<typeof AlertRuleDialog>["onSave"];
  onCloseRule: () => void;
  deleteRule: AlertRule | null;
  deleting: boolean;
  deleteError: string | null;
  onDelete: () => void;
  onCloseDelete: () => void;
  historyRule: AlertRule | null;
  history: ReturnType<typeof useAlertRuleHistory>;
  onCloseHistory: () => void;
}) {
  return (
    <>
      <AlertRuleDialog target={ruleDialog} groups={groups} agents={agents} saving={saving} error={saveError} onSave={onSave} onClose={onCloseRule} />
      <ConfirmDeleteDialog
        open={deleteRule !== null}
        pending={deleting}
        title={`Delete “${deleteRule ? ruleTitle(deleteRule) : ""}”?`}
        onClose={onCloseDelete}
        onConfirm={onDelete}
      >
        It stops applying right away to {deleteRule ? scopeLabels(deleteRule.scopes, groups, agentsById).join(", ") : ""}. Alerts it
        already raised stay in Events, but its own history can no longer be opened. This can’t be undone.
        {deleteError && (
          <span role="alert" className="mt-2 block text-destructive">
            Couldn’t delete it: {deleteError}
          </span>
        )}
      </ConfirmDeleteDialog>
      <AlertRuleHistoryDialog
        rule={historyRule}
        events={history.events}
        loading={history.loading}
        error={history.error ? errorText(history.error) : null}
        truncated={history.truncated}
        onRetry={history.refetch}
        onClose={onCloseHistory}
      />
    </>
  );
}
