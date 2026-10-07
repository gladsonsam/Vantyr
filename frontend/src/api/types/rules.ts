export type AlertRuleScopeKind = "all" | "group" | "agent";

export interface AlertRuleScope {
  kind: AlertRuleScopeKind;
  group_id?: string;
  agent_id?: string;
}

export type AlertRuleChannel = "url" | "keys" | "url_category" | "agent_offline" | "resource";
export type AlertRuleMatchMode = "substring" | "regex";
/** Monitoring (`resource`) metric. */
export type AlertRuleMetric = "cpu_pct" | "mem_pct" | "disk_pct";
/** Monitoring (`resource`) comparator: greater-than / less-than. */
export type AlertRuleComparator = "gt" | "lt";

export interface AlertRule {
  id: number;
  name: string;
  channel: AlertRuleChannel;
  pattern: string;
  match_mode: AlertRuleMatchMode;
  case_insensitive: boolean;
  cooldown_secs: number;
  enabled: boolean;
  take_screenshot?: boolean;
  // Monitoring channels only.
  metric?: AlertRuleMetric | null;
  comparator?: AlertRuleComparator | null;
  threshold?: number | null;
  duration_secs?: number | null;
  scopes: AlertRuleScope[];
}

// ── Effective rules (per-agent) ───────────────────────────────────────────────

/** Minimal alert rule row returned by the effective-rules endpoint. */
export interface AlertRuleRow {
  id: number;
  name: string;
  pattern: string;
  match_mode: string;
  case_insensitive: boolean;
  cooldown_secs: number;
  take_screenshot: boolean;
  scope_kind?: string;
}

// ── App block events ──────────────────────────────────────────────────────────

export interface AppBlockEvent {
  id: number;
  agent_id: string;
  agent_name: string;
  rule_id: number | null;
  rule_name: string | null;
  exe_name: string;
  killed_at: string;
}

// ── Internet block rules ──────────────────────────────────────────────────────

export interface RuleSchedule {
  /** Sunday=0 .. Saturday=6 (agent-local time). */
  day_of_week: number;
  start_minute: number;
  end_minute: number;
}

export interface InternetBlockRuleScope {
  kind: "all" | "group" | "agent";
  group_id?: string;
  agent_id?: string;
}

export interface InternetBlockRule {
  id: number;
  name: string;
  enabled: boolean;
  created_at: string;
  scopes: InternetBlockRuleScope[];
  schedules: RuleSchedule[];
}

// ── App block rules ───────────────────────────────────────────────────────────

export type AppBlockMatchMode = "exact" | "contains";

export interface AppBlockRuleScope {
  kind: "all" | "group" | "agent";
  group_id?: string;
  agent_id?: string;
}

export interface AppBlockRule {
  id: number;
  name: string;
  exe_pattern: string;
  match_mode: AppBlockMatchMode;
  enabled: boolean;
  created_at?: string;
  /** Present when fetching effective rules for an agent (summary of most-permissive scope). */
  scope_kind?: "all" | "group" | "agent";
  /** Present when fetching the full rule list (includes all scope rows). */
  scopes?: AppBlockRuleScope[];
  schedules: RuleSchedule[];
}

// ── Scheduled Scripts ───────────────────────────────────────────────────────────

export interface ScheduledScriptScope {
  kind: "all" | "group" | "agent";
  group_id?: string;
  agent_id?: string;
}

export interface ScheduledScriptSchedule {
  frequency: "hourly" | "daily" | "weekly";
  day_of_week?: number | null;
  fire_minute: number;
}

export interface ScheduledScript {
  id: number;
  name: string;
  shell: string;
  script: string;
  timeout_secs: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  scopes: ScheduledScriptScope[];
  schedules: ScheduledScriptSchedule[];
}

export interface ScheduledScriptEvent {
  script_id: number;
  agent_id: string;
  agent_name: string;
  rule_name?: string; // Only for global feed
  status: string;
  expected_fire_time: string;
  output?: string;
  is_manual?: boolean;
}

export interface AgentSessionEvent {
  id: number;
  agent_id: string;
  agent_name: string;
  connected_at: string;
  disconnected_at: string | null;
}
