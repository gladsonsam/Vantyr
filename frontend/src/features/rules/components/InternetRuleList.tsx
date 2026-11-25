import { CalendarClock, Clock, Users } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import type { Agent, AgentGroup, InternetBlockRule } from "@/api/types";
import { internetRuleTitle } from "../hooks/useInternetRuleMutations";
import { ruleScopeLabels, scheduleLabels } from "../lib/ruleSummary";
import { RuleDeleteMenu, RuleFact, RuleList, RuleRow } from "./RuleListRow";

export type InternetRuleAction = "schedule" | "delete";

/** One row per internet block rule: whether it is on, who it blocks and when. */
export function InternetRuleList({ rules, groups, agentsById, switchesDisabled, onToggle, onAction }: {
  rules: InternetBlockRule[];
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  switchesDisabled: boolean;
  onToggle: (rule: InternetBlockRule) => void;
  onAction: (rule: InternetBlockRule, action: InternetRuleAction) => void;
}) {
  return (
    <RuleList label="Internet block rules">
      {rules.map((r) => {
        const title = internetRuleTitle(r);
        const scopes = ruleScopeLabels(r.scopes, groups, agentsById);
        const when = scheduleLabels(r.schedules);
        const scheduled = r.schedules.length > 0;
        return (
          <RuleRow
            key={r.id}
            enabled={r.enabled}
            switchLabel={`Enable rule ${title}`}
            switchDisabled={switchesDisabled}
            onToggle={() => onToggle(r)}
            title={title}
            state={!r.enabled && "Off, not blocking"}
            facts={
              <>
                <RuleFact icon={Users} title={scopes.join(", ")}>Blocks {scopes.join(", ")}</RuleFact>
                <RuleFact icon={Clock}>
                  {when.join(", ")}
                  {scheduled && " · device time"}
                </RuleFact>
              </>
            }
            actions={
              <>
                <Button variant="outline" className="pointer-coarse:h-9" aria-label={`Edit schedule of ${title}`} onClick={() => onAction(r, "schedule")}>
                  <CalendarClock /> Edit schedule
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
