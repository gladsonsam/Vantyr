// ── Alert rules, app / internet blocking and scheduled scripts ───────────────
//
// Generated from the server's Rust structs (`./generated`, see server/docs/ARCHITECTURE.md) and
// re-exported under the names call sites use.

import type { AppBlockRuleListItem } from "./generated/AppBlockRuleListItem";
import type { AppBlockRuleRow } from "./generated/AppBlockRuleRow";
import type { AlertRuleListItem } from "./generated/AlertRuleListItem";
import type { ExecutionEvent } from "./generated/ExecutionEvent";
import type { ScheduledScriptSchedule as GeneratedSchedule } from "./generated/ScheduledScriptSchedule";
import type { ScheduledScriptScope as GeneratedScope } from "./generated/ScheduledScriptScope";
import type { ScriptExecutionEvent } from "./generated/ScriptExecutionEvent";

export type { AlertRuleListItem as AlertRule } from "./generated/AlertRuleListItem";
export type { AlertRuleScopeJson as AlertRuleScope } from "./generated/AlertRuleScopeJson";
/** Minimal alert rule row returned by the effective-rules endpoint. */
export type { AlertRuleRow } from "./generated/AlertRuleRow";
/** One alert firing as listed for an agent. */
export type { AlertRuleEventRow as AlertRuleEvent } from "./generated/AlertRuleEventRow";
/** One alert firing as listed for a rule or fleet-wide (names the agent that triggered it). */
export type { AlertRuleEventTriggeredRow as AlertRuleTriggeredEvent } from "./generated/AlertRuleEventTriggeredRow";

export type AlertRuleScopeKind = AlertRuleListItem["scopes"][number]["kind"];
export type AlertRuleChannel = AlertRuleListItem["channel"];
export type AlertRuleMatchMode = AlertRuleListItem["match_mode"];
/** Monitoring (`resource`) metric. */
export type AlertRuleMetric = NonNullable<AlertRuleListItem["metric"]>;
/** Monitoring (`resource`) comparator: greater-than / less-than. */
export type AlertRuleComparator = NonNullable<AlertRuleListItem["comparator"]>;

// ── App block events ──────────────────────────────────────────────────────────

export type { AppBlockEventRow as AppBlockEvent } from "./generated/AppBlockEventRow";

// ── Internet block rules ──────────────────────────────────────────────────────

/** Weekly active window; `day_of_week` is Sunday=0 .. Saturday=6 (agent-local time). */
export type { RuleScheduleJson as RuleSchedule } from "./generated/RuleScheduleJson";
export type { InternetBlockScopeJson as InternetBlockRuleScope } from "./generated/InternetBlockScopeJson";
export type { InternetBlockRuleRow as InternetBlockRule } from "./generated/InternetBlockRuleRow";

// ── App block rules ───────────────────────────────────────────────────────────

export type AppBlockMatchMode = AppBlockRuleListItem["match_mode"];
export type { AppBlockScopeJson as AppBlockRuleScope } from "./generated/AppBlockScopeJson";

/**
 * `GET /app-block-rules` returns the full list ({@link AppBlockRuleListItem}: all scope rows,
 * `created_at`) or, with `?agent_id=`, the rules applicable to that agent
 * ({@link AppBlockRuleRow}: one summarised `scope_kind`, no `scopes`/`created_at`). Call sites
 * handle both, so each shape's extra fields are optional here.
 */
export type AppBlockRule = Omit<AppBlockRuleListItem, "scopes" | "created_at"> &
  Partial<Pick<AppBlockRuleListItem, "scopes" | "created_at">> &
  Partial<Pick<AppBlockRuleRow, "scope_kind">>;

// ── Scheduled Scripts ───────────────────────────────────────────────────────────

export type { ScheduledScriptRow as ScheduledScript } from "./generated/ScheduledScriptRow";

/** A scope or schedule as the dashboard sends it: the server treats absent ids / day as `null`. */
export type ScheduledScriptScope = Pick<GeneratedScope, "kind"> & Partial<Pick<GeneratedScope, "group_id" | "agent_id">>;
export type ScheduledScriptSchedule = Omit<GeneratedSchedule, "day_of_week"> & Partial<Pick<GeneratedSchedule, "day_of_week">>;

/** The per-script log lacks `rule_name`/`is_manual`, which only the global feed carries. */
export type ScheduledScriptEvent = ScriptExecutionEvent & Partial<Pick<ExecutionEvent, "rule_name" | "is_manual">>;
