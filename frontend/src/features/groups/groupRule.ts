import type { AlertRule, AlertRuleScope, AlertRuleScopeKind } from "@/api/types";
import type { GroupRuleValues } from "./groupSchemas";

type ScopeFormRow = {
  kind: AlertRuleScopeKind;
  group_id: string;
  agent_id: string;
};

function formScopesToApi(rows: ScopeFormRow[]): AlertRuleScope[] {
  return rows.map((r) => {
    if (r.kind === "all") return { kind: "all" };
    if (r.kind === "group") return { kind: "group", group_id: r.group_id };
    return { kind: "agent", agent_id: r.agent_id };
  });
}

/** The unsaved alert rule the "New alert rule for this group" action starts from. */
export function newRuleForGroup(groupId: string, groupName: string): AlertRule {
  return {
    id: 0,
    name: groupName ? `${groupName} — ` : "",
    channel: "url",
    pattern: "",
    match_mode: "substring",
    case_insensitive: true,
    cooldown_secs: 300,
    enabled: true,
    take_screenshot: false,
    scopes: [{ kind: "group", group_id: groupId, agent_id: "" }],
  };
}

/** The create-rule request body for what the rule form holds. */
export function ruleRequestBody(data: GroupRuleValues) {
  return {
    name: data.name,
    channel: data.channel,
    pattern: data.pattern,
    match_mode: data.match_mode,
    case_insensitive: data.case_insensitive,
    cooldown_secs: data.cooldown_secs,
    enabled: data.enabled,
    take_screenshot: data.take_screenshot,
    scopes: formScopesToApi(data.scopes).map((s) => ({
      kind: s.kind,
      group_id: s.group_id,
      agent_id: s.agent_id,
    })),
  };
}
