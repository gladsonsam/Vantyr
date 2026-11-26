import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { errorText } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import type { Agent, AgentGroup, ScheduledScript } from "@/api/types";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { ErrorBanner } from "./components/RuleTabParts";
import { RuleTabLayout } from "./components/RuleTabLayout";
import {
  ScheduledScriptDialog,
  type ScheduledScriptDialogTarget,
} from "./components/ScheduledScriptDialog";
import { ScriptList, type ScriptAction } from "./components/ScriptList";
import { ScriptRunHistoryDialog } from "./components/ScriptRunHistoryDialog";
import { useRuleListView } from "./hooks/useRuleListView";
import { useScheduledScriptMutations } from "./hooks/useScheduledScriptMutations";
import { useScheduledScriptRuns } from "./hooks/useScheduledScriptRuns";
import { useSchedulerTimezone } from "./hooks/useSchedulerTimezone";
import { enabledCount, ruleScopeLabels, shellLabel } from "./lib/ruleSummary";

interface ScheduledScriptsTabProps {
  groups: AgentGroup[];
  agents: Agent[];
}

const NO_SCRIPTS: ScheduledScript[] = [];

const toScripts = (d: { scripts: ScheduledScript[] }) => d.scripts ?? NO_SCRIPTS;

export function ScheduledScriptsTab({ groups, agents }: ScheduledScriptsTabProps) {
  const scriptsQuery = useQuery({ ...ruleQueries.scheduledScripts(), select: toScripts });
  const scripts = scriptsQuery.data ?? NO_SCRIPTS;
  const runs = useScheduledScriptRuns();
  const timezone = useSchedulerTimezone();

  const [scriptDialog, setScriptDialog] = useState<ScheduledScriptDialogTarget>(null);
  const [historyScript, setHistoryScript] = useState<ScheduledScript | null>(null);
  const [deleteScript, setDeleteScript] = useState<ScheduledScript | null>(null);
  const [runScript, setRunScript] = useState<ScheduledScript | null>(null);

  const agentsById = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const scopeText = (s: ScheduledScript | null) =>
    s ? ruleScopeLabels(s.scopes, groups, agentsById).join(", ") : "";

  const { save, remove, toggle, trigger, actionError, setActionError, saved, setSaved } =
    useScheduledScriptMutations({
      onSaved: () => setScriptDialog(null),
      onDeleted: () => setDeleteScript(null),
      onRunRequested: () => setRunScript(null),
    });
  const haystack = useCallback(
    (r: ScheduledScript) => [r.name, r.shell, ...ruleScopeLabels(r.scopes, groups, agentsById)],
    [groups, agentsById],
  );
  const list = useRuleListView(scripts, haystack);

  const openScriptDialog = (target: NonNullable<ScheduledScriptDialogTarget>) => {
    save.reset();
    setSaved(null);
    setScriptDialog(target);
  };
  const onAction = (r: ScheduledScript, action: ScriptAction) => {
    if (action === "run") setRunScript(r);
    else if (action === "history") setHistoryScript(r);
    else if (action === "edit") openScriptDialog({ mode: "edit", script: r });
    else {
      remove.reset();
      setDeleteScript(r);
    }
  };

  const dialogs = (
    <>
      <ScheduledScriptDialog
        target={scriptDialog}
        groups={groups}
        agents={agents}
        saving={save.isPending}
        error={save.isError ? errorText(save.error) : null}
        onSave={(id, body) => save.mutate({ id, body })}
        onClose={() => {
          setScriptDialog(null);
          save.reset();
        }}
      />
      <ConfirmActionDialog
        open={runScript !== null}
        pending={trigger.isPending}
        title={`Run “${runScript?.name ?? ""}” now?`}
        confirmLabel="Run now"
        onClose={() => setRunScript(null)}
        onConfirm={() => runScript && trigger.mutate(runScript)}
      >
        It is sent right away to {scopeText(runScript)} and runs in{" "}
        {runScript ? shellLabel(runScript.shell) : ""} on each online device. Offline devices skip
        it. Each device reports its result afterwards, in Run history.
      </ConfirmActionDialog>
      <ConfirmDeleteDialog
        open={deleteScript !== null}
        pending={remove.isPending}
        title={`Delete “${deleteScript?.name ?? ""}”?`}
        onClose={() => setDeleteScript(null)}
        onConfirm={() => deleteScript && remove.mutate(deleteScript)}
      >
        It stops running on {scopeText(deleteScript)}. A run already sent isn’t recalled, and its
        run history can no longer be opened. This can’t be undone.
        {remove.isError && (
          <span role="alert" className="mt-2 block text-destructive">
            Couldn’t delete it: {errorText(remove.error)}
          </span>
        )}
      </ConfirmDeleteDialog>
      <ScriptRunHistoryDialog script={historyScript} onClose={() => setHistoryScript(null)} />
    </>
  );

  return (
    <RuleTabLayout
      noun="scheduled scripts"
      createLabel="New script"
      query={scriptsQuery}
      total={scripts.length}
      countSummary={enabledCount(scripts, "script")}
      list={list}
      searchLabel="Search scheduled scripts"
      searchPlaceholder="Search scripts…"
      empty={{
        title: "No scheduled scripts yet",
        description:
          "A scheduled script runs a PowerShell or CMD script on agents every hour, day or week.",
        icon: <FileCode />,
      }}
      actionError={actionError}
      onDismissAction={() => setActionError(null)}
      saved={saved}
      onDismissSaved={() => setSaved(null)}
      banners={
        runs.failed && (
          <ErrorBanner
            message="Couldn’t load how the last runs went, so last-run results are unknown."
            actionLabel="Try again"
            onAction={() => void runs.refetch()}
          />
        )
      }
      onCreate={() => openScriptDialog({ mode: "create" })}
      rows={
        <ScriptList
          scripts={list.displayed}
          groups={groups}
          agentsById={agentsById}
          lastRuns={runs.lastRuns}
          runsFailed={runs.failed}
          timezone={timezone}
          switchesDisabled={toggle.isPending}
          runDisabled={trigger.isPending}
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
