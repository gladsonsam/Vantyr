import type { Agent, AgentGroup, AlertRule, AlertRuleScope } from "@/api/types";

export const CHANNEL_LABEL: Record<string, string> = {
  url: "URL",
  url_category: "URL category",
  keys: "Keystrokes",
  resource: "Resource threshold",
  agent_offline: "Agent offline",
};

const METRIC_LABEL: Record<string, string> = {
  cpu_pct: "CPU",
  mem_pct: "Memory",
  disk_pct: "Disk",
};

export const channelLabel = (channel: string): string => CHANNEL_LABEL[channel] ?? channel;

/** What a rule watches for, in a few words ("CPU > 90%", "Offline ≥ 10 min", or the pattern itself). */
export function ruleMatchSummary(r: AlertRule): string {
  if (r.channel === "resource") {
    return `${METRIC_LABEL[r.metric ?? "cpu_pct"] ?? r.metric} ${r.comparator === "lt" ? "<" : ">"} ${r.threshold ?? 0}%`;
  }
  if (r.channel === "agent_offline") {
    return `Offline ≥ ${Math.round((r.duration_secs ?? 300) / 60)} min`;
  }
  return r.pattern;
}

/** The name a rule is listed under: its own name, or what it matches when it has none. */
export const ruleTitle = (r: AlertRule): string =>
  r.name.trim() || ruleMatchSummary(r) || channelLabel(r.channel);

/** "30 s", "5 min", "2 h": the largest whole unit a duration divides into. */
export function fmtSeconds(secs: number): string {
  if (secs % 3600 === 0 && secs >= 3600) return `${secs / 3600} h`;
  if (secs % 60 === 0 && secs >= 60) return `${secs / 60} min`;
  return `${secs} s`;
}

/** How often a matching rule may fire again for the same agent. */
export function cooldownLabel(secs: number): string {
  return secs <= 0 ? "Fires on every match" : `At most once per ${fmtSeconds(secs)} per agent`;
}

/**
 * Every distinct place a rule applies, one label each, in the order the rule lists them.
 * A rule with no scope rows applies nowhere, which is said rather than left blank.
 */
export function scopeLabels(
  scopes: AlertRuleScope[] | undefined,
  groups: AgentGroup[],
  agentsById: Record<string, Agent>,
): string[] {
  if (!scopes || scopes.length === 0) return ["No scope"];
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const s of scopes) {
    const label =
      s.kind === "all"
        ? "All devices"
        : s.kind === "group"
          ? `Group · ${(s.group_id ? groupNames.get(s.group_id) : undefined) ?? "unknown"}`
          : `Agent · ${(s.agent_id ? agentsById[s.agent_id]?.name : undefined) ?? "unknown"}`;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  // "All devices" already covers everything else the rule lists.
  return labels.includes("All devices") ? ["All devices"] : labels;
}

/** Counts shown above the list: "6 rules · 5 on". */
export function ruleCountSummary(rules: AlertRule[]): string {
  const on = rules.filter((r) => r.enabled).length;
  const noun = rules.length === 1 ? "rule" : "rules";
  return on === rules.length
    ? `${rules.length} ${noun} · all on`
    : `${rules.length} ${noun} · ${on} on`;
}
