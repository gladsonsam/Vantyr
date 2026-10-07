import React, { type ReactNode } from "react";
import type { AlertRuleScope, AgentGroup, Agent, AppBlockRule, ScheduledScriptSchedule } from "@/lib/types";

export type ScopeFormRow = { kind: "all" | "group" | "agent"; group_id: string; agent_id: string };

export function emptyScopeRow(): ScopeFormRow {
  return { kind: "all", group_id: "", agent_id: "" };
}

export function scopesToForm(scopes: AlertRuleScope[]): ScopeFormRow[] {
  if (!scopes || scopes.length === 0) return [emptyScopeRow()];
  return scopes.map((s) => ({
    kind: s.kind as "all" | "group" | "agent",
    group_id: s.group_id ?? "",
    agent_id: s.agent_id ?? "",
  }));
}

export function formScopesToApi(rows: ScopeFormRow[]): AlertRuleScope[] {
  return rows.map((r) => {
    if (r.kind === "all") return { kind: "all" };
    if (r.kind === "group") return { kind: "group", group_id: r.group_id };
    return { kind: "agent", agent_id: r.agent_id };
  });
}

const span = (className: string, ...children: ReactNode[]) =>
  React.createElement("span", { className }, ...children);

/**
 * Scope is carried by hue on plain text — never a circular/pill badge.
 */
export function scopeBadge(scopes?: AlertRuleScope[], groups?: AgentGroup[], agentsById?: Record<string, Agent>): ReactNode {
  if (!scopes || scopes.length === 0) return span("text-muted-foreground", "—");
  const s = scopes[0];
  if (s.kind === "all") return span("text-foreground", "All devices");
  if (s.kind === "group") {
    const g = groups?.find((x) => x.id === s.group_id);
    return span("text-foreground", `Group · ${g?.name ?? s.group_id ?? "?"}`);
  }
  const a = s.agent_id ? agentsById?.[s.agent_id] : undefined;
  return span("text-foreground", `Agent · ${a?.name ?? s.agent_id ?? "?"}`);
}

export function appBlockScopeBadge(rule: AppBlockRule, groups?: AgentGroup[], agentsById?: Record<string, Agent>): ReactNode {
  if (!rule.scopes || rule.scopes.length === 0) {
    const kind = rule.scope_kind ?? "agent";
    if (kind === "all") return span("text-foreground", "All devices");
    if (kind === "group") return span("text-foreground", "Group");
    return span("text-foreground", "This device");
  }
  return scopeBadge(rule.scopes as unknown as AlertRuleScope[], groups, agentsById);
}

export function inetScopeBadge(rule: { scopes: { kind: "all" | "group" | "agent"; group_id?: string; agent_id?: string }[] }, groups: AgentGroup[], agents: Agent[]): ReactNode {
  const s = rule.scopes[0];
  if (!s) return span("text-muted-foreground", "—");
  if (s.kind === "all") return span("text-foreground", "All devices");
  if (s.kind === "group") {
    const g = groups.find((x) => x.id === s.group_id);
    return span("text-foreground", `Group · ${g?.name ?? "?"}`);
  }
  const a = agents.find((x) => x.id === s.agent_id);
  return span("text-foreground", `Agent · ${a?.name ?? "?"}`);
}

export const timeToMinute = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const hhRaw = parseInt(m[1], 10);
  const mmRaw = parseInt(m[2], 10);
  const mm = Math.max(0, Math.min(59, mmRaw));
  if (hhRaw === 24 && mm === 0) return 1440;
  const hh = Math.max(0, Math.min(23, hhRaw));
  return hh * 60 + mm;
};

export const minuteToTime = (min: number): string => {
  const m = Math.max(0, Math.min(1440, Math.floor(min)));
  if (m === 1440) return "24:00";
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
};

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

export const scheduleSummary = (schedules?: { day_of_week: number; start_minute: number; end_minute: number }[]): ReactNode => {
  if (!schedules || schedules.length === 0) return span("text-muted-foreground", "Always");
  const day = (d: number) => DAY_OPTIONS.find((o) => o.value === String(d))?.label?.slice(0, 3) ?? "?";
  const parts = schedules.slice(0, 2).map((w) => `${day(w.day_of_week)} ${minuteToTime(w.start_minute)}–${minuteToTime(w.end_minute)}`);
  const more = schedules.length > 2 ? ` +${schedules.length - 2}` : "";
  return span("", `${parts.join(", ")}${more}`);
};

export const scheduledScriptScheduleSummary = (schedules: ScheduledScriptSchedule[]): ReactNode => {
  if (!schedules || schedules.length === 0) return span("text-muted-foreground", "None");
  const s = schedules[0];
  if (s.frequency === "hourly") return `Hourly at minute ${s.fire_minute}`;
  const timeStr = minuteToTime(s.fire_minute);
  if (s.frequency === "daily") return `Daily at ${timeStr}`;
  if (s.frequency === "weekly") {
    const day = s.day_of_week != null ? (DAY_OPTIONS.find(o => String(o.value) === String(s.day_of_week))?.label ?? "?") : "?";
    return `Weekly on ${day} at ${timeStr}`;
  }
  return "?";
};
