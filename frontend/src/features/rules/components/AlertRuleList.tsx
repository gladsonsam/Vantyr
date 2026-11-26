import { BellRing, Camera, Clock, History, MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { Switch } from "@/components/common/SettingsSwitch";
import { RuleIconTile } from "./RuleListRow";
import type { Agent, AgentGroup, AlertRule } from "@/api/types";
import {
  channelLabel,
  cooldownLabel,
  fmtSeconds,
  ruleMatchSummary,
  ruleTitle,
  scopeLabels,
} from "../lib/alertRuleSummary";

export type AlertRuleAction = "history" | "edit" | "delete";

/** Scope labels shown before the rest collapse into "+N more" (the edit dialog lists them all). */
const SCOPES_SHOWN = 2;

/** One row per alert rule: whether it is on, what it watches, where it applies, then its actions. */
export function AlertRuleList({
  rules,
  groups,
  agentsById,
  switchesDisabled,
  onToggle,
  onAction,
}: {
  rules: AlertRule[];
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  /** A change is being saved; further toggles wait for it. */
  switchesDisabled: boolean;
  onToggle: (rule: AlertRule) => void;
  onAction: (rule: AlertRule, action: AlertRuleAction) => void;
}) {
  return (
    <ul aria-label="Alert rules">
      {rules.map((r) => (
        <AlertRuleItem
          key={r.id}
          rule={r}
          groups={groups}
          agentsById={agentsById}
          switchDisabled={switchesDisabled}
          onToggle={onToggle}
          onAction={onAction}
        />
      ))}
    </ul>
  );
}

function AlertRuleItem({
  rule: r,
  groups,
  agentsById,
  switchDisabled,
  onToggle,
  onAction,
}: {
  rule: AlertRule;
  groups: AgentGroup[];
  agentsById: Record<string, Agent>;
  switchDisabled: boolean;
  onToggle: (rule: AlertRule) => void;
  onAction: (rule: AlertRule, action: AlertRuleAction) => void;
}) {
  const title = ruleTitle(r);
  const match = ruleMatchSummary(r);
  const scopes = scopeLabels(r.scopes, groups, agentsById);
  const shown = scopes.slice(0, SCOPES_SHOWN);
  const hidden = scopes.length - shown.length;
  const takesScreenshot = r.take_screenshot && r.channel !== "agent_offline";

  return (
    <li className="flex flex-col gap-3 border-b border-border/60 p-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 transition-colors hover:bg-muted/40">
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        <RuleIconTile icon={BellRing} enabled={r.enabled} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-medium">{title}</h3>
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground/80">{channelLabel(r.channel)}</span>
            {r.name.trim() && match && (
              <span className="min-w-0 truncate font-sans text-xs" title={match}>
                {match}
              </span>
            )}
            {!r.enabled && <span className="font-medium text-foreground">Off, not firing</span>}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5" title={scopes.join(", ")}>
              <Users className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {shown.join(", ")}
                {hidden > 0 && ` +${hidden} more`}
              </span>
            </span>
            <span
              className="inline-flex items-center gap-1.5"
              title={cooldownLabel(r.cooldown_secs)}
            >
              <Clock className="size-3.5 shrink-0" aria-hidden />
              {r.cooldown_secs <= 0 ? "Every match" : `Once per ${fmtSeconds(r.cooldown_secs)}`}
            </span>
            {takesScreenshot && (
              <span className="inline-flex items-center gap-1.5">
                <Camera className="size-3.5 shrink-0" aria-hidden /> Screenshot
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-[3.5rem] sm:pl-0">
        <Switch
          className="after:absolute after:-inset-1.5 after:content-['']"
          aria-label={`Enable rule ${title}`}
          checked={r.enabled}
          disabled={switchDisabled}
          onCheckedChange={() => onToggle(r)}
        />
        <Button
          variant="outline"
          className="pointer-coarse:h-9"
          aria-label={`Event history for ${title}`}
          onClick={() => onAction(r, "history")}
        >
          <History /> History
        </Button>
        <Button
          variant="ghost"
          className="pointer-coarse:h-9"
          aria-label={`Edit ${title}`}
          onClick={() => onAction(r, "edit")}
        >
          <Pencil /> Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="pointer-coarse:size-9"
                aria-label={`More actions for ${title}`}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={() => onAction(r, "delete")}>
              <Trash2 /> Delete rule…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
