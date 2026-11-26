import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { errorText } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import type { Agent, AgentGroup, InternetBlockRule } from "@/api/types";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { InternetBlockRuleDialog } from "./components/InternetBlockRuleDialog";
import { InternetRuleList, type InternetRuleAction } from "./components/InternetRuleList";
import { InternetScheduleDialog } from "./components/InternetScheduleDialog";
import { RuleTabLayout } from "./components/RuleTabLayout";
import { internetRuleTitle, useInternetRuleMutations } from "./hooks/useInternetRuleMutations";
import { useRuleListView } from "./hooks/useRuleListView";
import { enabledCount, ruleScopeLabels } from "./lib/ruleSummary";

interface InternetAccessTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const NO_RULES: InternetBlockRule[] = [];

const toRules = (d: { rules: InternetBlockRule[] }) => d.rules ?? NO_RULES;

export function InternetAccessTab({ groups, agents }: InternetAccessTabProps) {
  const rulesQuery = useQuery({ ...ruleQueries.internetBlockRules(), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;

  const [showCreate, setShowCreate] = useState(false);
  const [scheduleRule, setScheduleRule] = useState<InternetBlockRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<InternetBlockRule | null>(null);
  /** An always-on rule being switched on: it cuts devices off at once, so it asks first. */
  const [enableRule, setEnableRule] = useState<InternetBlockRule | null>(null);

  const agentsById = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const scopeText = (r: InternetBlockRule | null) =>
    r ? ruleScopeLabels(r.scopes, groups, agentsById).join(", ") : "";

  const { create, toggle, scheduleSave, remove, actionError, setActionError, saved, setSaved } =
    useInternetRuleMutations({
      onCreated: () => setShowCreate(false),
      onScheduleSaved: () => setScheduleRule(null),
      onDeleted: () => setDeleteRule(null),
      onToggled: () => setEnableRule(null),
    });
  const haystack = useCallback(
    (r: InternetBlockRule) => [r.name, ...ruleScopeLabels(r.scopes, groups, agentsById)],
    [groups, agentsById],
  );
  const list = useRuleListView(rules, haystack);

  const openCreate = () => {
    create.reset();
    setSaved(null);
    setShowCreate(true);
  };
  const onToggle = (r: InternetBlockRule) => {
    setActionError(null);
    setSaved(null);
    if (!r.enabled && r.schedules.length === 0) setEnableRule(r);
    else toggle.mutate(r);
  };
  const onAction = (r: InternetBlockRule, action: InternetRuleAction) => {
    if (action === "schedule") {
      scheduleSave.reset();
      setSaved(null);
      setScheduleRule(r);
    } else {
      remove.reset();
      setDeleteRule(r);
    }
  };

  const dialogs = (
    <>
      <InternetBlockRuleDialog
        open={showCreate}
        groups={groups}
        agents={agents}
        saving={create.isPending}
        error={create.isError ? errorText(create.error) : null}
        onSave={(body) => create.mutate(body)}
        onClose={() => {
          setShowCreate(false);
          create.reset();
        }}
      />
      <InternetScheduleDialog
        rule={scheduleRule}
        saving={scheduleSave.isPending}
        error={scheduleSave.isError ? errorText(scheduleSave.error) : null}
        onSave={(rule, schedules) => scheduleSave.mutate({ rule, schedules })}
        onClose={() => {
          setScheduleRule(null);
          scheduleSave.reset();
        }}
      />
      <ConfirmActionDialog
        open={enableRule !== null}
        pending={toggle.isPending}
        title={`Turn on “${enableRule ? internetRuleTitle(enableRule) : ""}”?`}
        confirmLabel="Block internet"
        destructive
        onClose={() => setEnableRule(null)}
        onConfirm={() => enableRule && toggle.mutate(enableRule)}
      >
        It has no schedule, so internet access is cut on {scopeText(enableRule)}: right away on
        connected devices, and on offline ones when they reconnect. Their connection to Vantyr keeps
        working.
      </ConfirmActionDialog>
      <ConfirmDeleteDialog
        open={deleteRule !== null}
        pending={remove.isPending}
        title={`Delete “${deleteRule ? internetRuleTitle(deleteRule) : ""}”?`}
        onClose={() => setDeleteRule(null)}
        onConfirm={() => deleteRule && remove.mutate(deleteRule)}
      >
        It stops blocking {scopeText(deleteRule)} as devices get the change; offline devices when
        they reconnect. Internet stays blocked on a device that another rule or a manual block still
        covers. This can’t be undone.
        {remove.isError && (
          <span role="alert" className="mt-2 block text-destructive">
            Couldn’t delete it: {errorText(remove.error)}
          </span>
        )}
      </ConfirmDeleteDialog>
    </>
  );

  return (
    <RuleTabLayout
      noun="internet block rules"
      createLabel="New rule"
      query={rulesQuery}
      total={rules.length}
      countSummary={enabledCount(rules, "rule")}
      list={list}
      searchLabel="Search internet block rules"
      searchPlaceholder="Search rules…"
      empty={{
        title: "No internet block rules yet",
        description:
          "A rule cuts internet access for all devices, a group or one agent, always or during set hours.",
        icon: <Globe />,
      }}
      actionError={actionError}
      onDismissAction={() => setActionError(null)}
      saved={saved}
      onDismissSaved={() => setSaved(null)}
      onCreate={openCreate}
      rows={
        <InternetRuleList
          rules={list.displayed}
          groups={groups}
          agentsById={agentsById}
          switchesDisabled={toggle.isPending}
          onToggle={onToggle}
          onAction={onAction}
        />
      }
      dialogs={dialogs}
    />
  );
}
