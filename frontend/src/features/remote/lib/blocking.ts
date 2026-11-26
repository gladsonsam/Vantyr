import type { AppBlockRule } from "@/api/types";

export type RuleScopeKind = "agent" | "group" | "all";

/** The one scope a listed rule reads as: the summarised kind, else the first scope row, else this device. */
export function resolvedScopeKind(rule: AppBlockRule): RuleScopeKind {
  const kind = rule.scope_kind ?? rule.scopes?.[0]?.kind ?? "agent";
  return kind === "all" || kind === "group" ? kind : "agent";
}

export function scopeLabel(kind: RuleScopeKind): string {
  if (kind === "all") return "All devices";
  if (kind === "group") return "Group";
  return "This device";
}

export function matchModeLabel(mode: string): string {
  if (mode === "exact") return "Exact name";
  if (mode === "contains") return "Name contains";
  return mode;
}

/** Who set a block that this page can't undo (null: set for this device alone, so it can be changed here). */
export function blockSourceLabel(source: string | null): string | null {
  if (source === "all") return "an all-devices rule";
  if (source === "group") return "a group rule";
  return null;
}

/** "No rules", "1 rule · on", "3 rules · 2 on". */
export function rulesSummary(rules: readonly AppBlockRule[]): string {
  if (rules.length === 0) return "No rules";
  const on = rules.filter((r) => r.enabled).length;
  const noun = rules.length === 1 ? "rule" : "rules";
  if (on === rules.length) return `${rules.length} ${noun} · all on`;
  return `${rules.length} ${noun} · ${on === 0 ? "all off" : `${on} on`}`;
}

/** What deleting a rule changes, including where else it stops applying. */
export function deleteConsequence(rule: AppBlockRule): string {
  const name = rule.name || rule.exe_pattern;
  const kind = resolvedScopeKind(rule);
  if (kind === "all") return `“${name}” will stop blocking on every device, not just this one.`;
  if (kind === "group")
    return `“${name}” will stop blocking on every device in its group, not just this one.`;
  return `“${name}” will stop being blocked on this device.`;
}

/** A reported capability value as a phrase ("needs_privilege" → "needs privilege"). */
export function capabilityPhrase(status: string | null): string {
  return (status ?? "unsupported").replace(/_/g, " ");
}
