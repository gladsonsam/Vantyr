import type { api } from "@/api";
import type { AlertRule, AlertRuleChannel, AlertRuleComparator, AlertRuleMatchMode, AlertRuleMetric } from "@/api/types";
import { emptyScopeRow, formScopesToApi, scopesToForm, type ScopeFormRow } from "../rulesUtils";

export interface AlertRuleForm {
  name: string;
  channel: AlertRuleChannel;
  pattern: string;
  match_mode: AlertRuleMatchMode;
  case_insensitive: boolean;
  cooldown_secs: number;
  enabled: boolean;
  take_screenshot: boolean;
  // Monitoring channels.
  metric: AlertRuleMetric;
  comparator: AlertRuleComparator;
  threshold: number;
  duration_mins: number;
  scopes: ScopeFormRow[];
}

export type AlertRuleBody = Parameters<typeof api.alertRulesCreate>[0];

export const isMonitoringChannel = (c: AlertRuleChannel) => c === "resource" || c === "agent_offline";

export function defaultAlertRuleForm(): AlertRuleForm {
  return { name: "", channel: "url", pattern: "", match_mode: "substring", case_insensitive: true, cooldown_secs: 300, enabled: true, take_screenshot: false, metric: "cpu_pct", comparator: "gt", threshold: 90, duration_mins: 5, scopes: [emptyScopeRow()] };
}

export function alertRuleToForm(r: AlertRule): AlertRuleForm {
  return {
    name: r.name,
    channel: r.channel,
    pattern: r.pattern,
    match_mode: r.match_mode,
    case_insensitive: r.case_insensitive,
    cooldown_secs: r.cooldown_secs,
    enabled: r.enabled,
    take_screenshot: Boolean(r.take_screenshot),
    metric: r.metric ?? "cpu_pct",
    comparator: r.comparator ?? "gt",
    threshold: r.threshold ?? 90,
    duration_mins: Math.max(1, Math.round((r.duration_secs ?? 300) / 60)),
    scopes: scopesToForm(r.scopes ?? []),
  };
}

/** The request body for a form that already passed validation. */
export function alertRuleFormToBody(form: AlertRuleForm): AlertRuleBody {
  const monitoring = isMonitoringChannel(form.channel);
  return {
    name: form.name.trim(),
    channel: form.channel,
    pattern: monitoring ? "" : form.pattern.trim(),
    match_mode: form.match_mode,
    case_insensitive: form.case_insensitive,
    cooldown_secs: form.cooldown_secs,
    enabled: form.enabled,
    take_screenshot: form.channel === "agent_offline" ? false : form.take_screenshot,
    metric: form.channel === "resource" ? form.metric : null,
    comparator: form.channel === "resource" ? form.comparator : null,
    threshold: form.channel === "resource" ? form.threshold : null,
    duration_secs: form.channel === "agent_offline" ? Math.max(0, Math.round(form.duration_mins * 60)) : null,
    scopes: formScopesToApi(form.scopes).map((s) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })),
  };
}
