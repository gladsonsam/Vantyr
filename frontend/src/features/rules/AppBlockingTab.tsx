import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldBan } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { errorText } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";
import { AppBlockHistoryDialog } from "./components/AppBlockHistoryDialog";
import { AppBlockList, type AppBlockAction } from "./components/AppBlockList";
import { AppBlockRuleDialog, type AppBlockRuleDialogTarget } from "./components/AppBlockRuleDialog";
import { RuleTabLayout } from "./components/RuleTabLayout";
import { appBlockTitle, useAppBlockMutations } from "./hooks/useAppBlockMutations";
import { useRuleListView } from "./hooks/useRuleListView";
import { appBlockScopeLabels, enabledCount } from "./lib/ruleSummary";

interface AppBlockingTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const NO_RULES: AppBlockRule[] = [];

const toRules = (d: { rules: AppBlockRule[] }) => d.rules ?? NO_RULES;

export function AppBlockingTab({ groups, agents }: AppBlockingTabProps) {
  const rulesQuery = useQuery({ ...ruleQueries.appBlockRules(), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;

  const [ruleDialog, setRuleDialog] = useState<AppBlockRuleDialogTarget>(null);
  const [historyRule, setHistoryRule] = useState<AppBlockRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<AppBlockRule | null>(null);

  const agentsById = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const contextAgentId = agents[0]?.id ?? "";

  const { toggle, save, remove, actionError, setActionError, saved, setSaved } = useAppBlockMutations({
    onSaved: () => setRuleDialog(null),
    onDeleted: () => setDeleteRule(null),
  });
  const haystack = useCallback(
    (r: AppBlockRule) => [r.name, r.exe_pattern, ...appBlockScopeLabels(r, groups, agentsById)],
    [groups, agentsById],
  );
  const list = useRuleListView(rules, haystack);

  const openRuleDialog = (target: NonNullable<AppBlockRuleDialogTarget>) => {
    save.reset();
    setSaved(null);
    setRuleDialog(target);
  };
  const onAction = (r: AppBlockRule, action: AppBlockAction) => {
    if (action === "history") setHistoryRule(r);
    else if (action === "edit") openRuleDialog({ mode: "edit", rule: r });
    else {
      remove.reset();
      setDeleteRule(r);
    }
  };

  const dialogs = (
    <>
      <AppBlockRuleDialog
        target={ruleDialog}
        groups={groups}
        agents={agents}
        contextAgentId={contextAgentId}
        saving={save.isPending}
        error={save.isError ? errorText(save.error) : null}
        onSave={(id, body) => save.mutate({ id, body })}
        onClose={() => {
          setRuleDialog(null);
          save.reset();
        }}
      />
      <ConfirmDeleteDialog
        open={deleteRule !== null}
        pending={remove.isPending}
        title={`Delete “${deleteRule ? appBlockTitle(deleteRule) : ""}”?`}
        onClose={() => setDeleteRule(null)}
        onConfirm={() => deleteRule && remove.mutate(deleteRule)}
      >
        {deleteRule?.exe_pattern} stops being closed on {deleteRule ? appBlockScopeLabels(deleteRule, groups, agentsById).join(", ") : ""} as devices
        get the change; offline devices when they reconnect. What it already closed stays in Events, but this rule’s own history can
        no longer be opened. This can’t be undone.
        {remove.isError && (
          <span role="alert" className="mt-2 block text-destructive">
            Couldn’t delete it: {errorText(remove.error)}
          </span>
        )}
      </ConfirmDeleteDialog>
      <AppBlockHistoryDialog rule={historyRule} onClose={() => setHistoryRule(null)} />
    </>
  );

  return (
    <RuleTabLayout
      noun="app block rules"
      createLabel="New rule"
      query={rulesQuery}
      total={rules.length}
      countSummary={enabledCount(rules, "rule")}
      list={list}
      searchLabel="Search app block rules"
      searchPlaceholder="Search rules…"
      empty={{
        title: "No app block rules yet",
        description: "An app block rule closes an app every time it starts on the devices you choose.",
        icon: <ShieldBan />,
      }}
      actionError={actionError}
      onDismissAction={() => setActionError(null)}
      saved={saved}
      onDismissSaved={() => setSaved(null)}
      onCreate={() => openRuleDialog({ mode: "create" })}
      rows={
        <AppBlockList
          rules={list.displayed}
          groups={groups}
          agentsById={agentsById}
          contextAgentId={contextAgentId}
          switchesDisabled={toggle.isPending}
          onToggle={(r) => {
            setActionError(null);
            setSaved(null);
            toggle.mutate(r);
          }}
          onAction={onAction}
        />
      }
      dialogs={dialogs}
    />
  );
}
