import { Clock, History, Pencil, Users } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { AppIcon } from "@/components/common/AppIcon";
import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";
import { appBlockTitle } from "../hooks/useAppBlockMutations";
import { appBlockScopeLabels, scheduleCaption, scheduleLabels } from "../lib/ruleSummary";
import { RuleDeleteMenu, RuleFact, RuleList, RuleRow } from "./RuleListRow";

export type AppBlockAction = "history" | "edit" | "delete";

const MATCH_LABEL = { exact: "Exact name", contains: "Name contains" } as const;

/** One row per app block rule: whether it is on, which app, where it applies and when. */
export function AppBlockList({ rules, groups, agentsById, contextAgentId, switchesDisabled, onToggle, onAction }: {
  rules: AppBlockRule[];
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  /** Whose icons the executables are drawn with. */
  contextAgentId: string;
  switchesDisabled: boolean;
  onToggle: (rule: AppBlockRule) => void;
  onAction: (rule: AppBlockRule, action: AppBlockAction) => void;
}) {
  return (
    <RuleList label="App block rules">
      {rules.map((r) => {
        const title = appBlockTitle(r);
        const scopes = appBlockScopeLabels(r, groups, agentsById);
        const when = scheduleLabels(r.schedules);
        const scheduled = Boolean(r.schedules?.length);
        return (
          <RuleRow
            key={r.id}
            enabled={r.enabled}
            switchLabel={`Enable block rule ${title}`}
            switchDisabled={switchesDisabled}
            onToggle={() => onToggle(r)}
            title={title}
            lead={
              <>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {contextAgentId && <AppIcon agentId={contextAgentId} exeName={r.exe_pattern} size={16} />}
                  <span className="min-w-0 break-all font-mono text-xs">{r.exe_pattern}</span>
                </span>
                <span className="text-xs">{MATCH_LABEL[r.match_mode] ?? r.match_mode}</span>
              </>
            }
            state={!r.enabled && "Off, not blocking"}
            facts={
              <>
                <RuleFact icon={Users} title={scopes.join(", ")}>{scopes.join(", ")}</RuleFact>
                <RuleFact icon={Clock} title={scheduleCaption(r.schedules)}>
                  {when.join(", ")}
                  {scheduled && " · device time"}
                </RuleFact>
              </>
            }
            actions={
              <>
                <Button variant="outline" className="pointer-coarse:h-9" aria-label={`Closed-app history for ${title}`} onClick={() => onAction(r, "history")}>
                  <History /> History
                </Button>
                <Button variant="ghost" className="pointer-coarse:h-9" aria-label={`Edit ${title}`} onClick={() => onAction(r, "edit")}>
                  <Pencil /> Edit
                </Button>
                <RuleDeleteMenu title={title} deleteLabel="Delete rule…" onDelete={() => onAction(r, "delete")} />
              </>
            }
          />
        );
      })}
    </RuleList>
  );
}
