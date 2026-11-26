import { CalendarClock, History, Pencil, Play, Users } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import type { Agent, AgentGroup, ScheduledScript } from "@/api/types";
import type { LastRuns } from "../hooks/useScheduledScriptRuns";
import { ruleScopeLabels, scriptScheduleLabels, shellLabel } from "../lib/ruleSummary";
import { RuleDeleteMenu, RuleFact, RuleList, RuleRow } from "./RuleListRow";
import { ScriptLastRun } from "./ScriptLastRun";

export type ScriptAction = "run" | "history" | "edit" | "delete";

/** One row per scheduled script: whether it is on, where it runs, when it fires and how the last run went. */
export function ScriptList({
  scripts,
  groups,
  agentsById,
  lastRuns,
  runsFailed,
  timezone,
  switchesDisabled,
  runDisabled,
  onToggle,
  onAction,
}: {
  scripts: ScheduledScript[];
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  lastRuns: LastRuns;
  /** The run feed couldn't be read, so "last run" is unknown rather than empty. */
  runsFailed: boolean;
  /** The timezone the schedule follows, when known. */
  timezone: string | null;
  switchesDisabled: boolean;
  runDisabled: boolean;
  onToggle: (script: ScheduledScript) => void;
  onAction: (script: ScheduledScript, action: ScriptAction) => void;
}) {
  return (
    <RuleList label="Scheduled scripts">
      {scripts.map((r) => {
        const title = r.name || "Unnamed script";
        const scopes = ruleScopeLabels(r.scopes, groups, agentsById);
        const when = scriptScheduleLabels(r.schedules);
        return (
          <RuleRow
            key={r.id}
            enabled={r.enabled}
            switchLabel={`Enable script ${title}`}
            switchDisabled={switchesDisabled}
            onToggle={() => onToggle(r)}
            title={title}
            lead={<span className="font-mono text-xs">{shellLabel(r.shell)}</span>}
            state={!r.enabled && "Off, won’t run on its schedule"}
            facts={
              <>
                <RuleFact icon={Users} title={scopes.join(", ")}>
                  {scopes.join(", ")}
                </RuleFact>
                <RuleFact icon={CalendarClock} title={when.join(", ")}>
                  {when.join(", ")}
                  {r.schedules.length > 0 && ` · ${timezone ?? "server time"}`}
                </RuleFact>
                <RuleFact icon={History}>
                  <ScriptLastRun run={lastRuns[r.id]} failed={runsFailed} />
                </RuleFact>
              </>
            }
            actions={
              <>
                <Button
                  variant="outline"
                  className="pointer-coarse:h-9"
                  disabled={runDisabled}
                  aria-label={`Run ${title} now`}
                  onClick={() => onAction(r, "run")}
                >
                  <Play /> Run now
                </Button>
                <Button
                  variant="ghost"
                  className="pointer-coarse:h-9"
                  aria-label={`Run history for ${title}`}
                  onClick={() => onAction(r, "history")}
                >
                  <History /> Run history
                </Button>
                <Button
                  variant="ghost"
                  className="pointer-coarse:h-9"
                  aria-label={`Edit ${title}`}
                  onClick={() => onAction(r, "edit")}
                >
                  <Pencil /> Edit
                </Button>
                <RuleDeleteMenu
                  title={title}
                  deleteLabel="Delete script…"
                  onDelete={() => onAction(r, "delete")}
                />
              </>
            }
          />
        );
      })}
    </RuleList>
  );
}
