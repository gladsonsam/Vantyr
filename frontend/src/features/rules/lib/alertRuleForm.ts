import { z } from "zod";
import type { api } from "@/api";
import type { AlertRule, AlertRuleChannel } from "@/api/types";
import { emptyScopeRow, formScopesToApi, scopesToForm } from "../rulesUtils";

const scopeRowSchema = z.object({
  kind: z.enum(["all", "group", "agent"]),
  group_id: z.string(),
  agent_id: z.string(),
});

export const alertRuleSchema = z
  .object({
    name: z.string(),
    channel: z.enum(["url", "keys", "url_category", "agent_offline", "resource"]),
    pattern: z.string(),
    match_mode: z.enum(["substring", "regex"]),
    case_insensitive: z.boolean(),
    cooldown_secs: z.number().min(0),
    enabled: z.boolean(),
    take_screenshot: z.boolean(),
    // Monitoring channels.
    metric: z.enum(["cpu_pct", "mem_pct", "disk_pct"]),
    comparator: z.enum(["gt", "lt"]),
    threshold: z.number().min(0).max(100),
    duration_mins: z.number().min(1),
    scopes: z.array(scopeRowSchema),
  })
  .superRefine((form, ctx) => {
    if (!isMonitoringChannel(form.channel) && !form.pattern.trim()) {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: "Pattern is required" });
    }
  });

export type AlertRuleForm = z.infer<typeof alertRuleSchema>;

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
