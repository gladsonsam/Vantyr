import type {
  Agent,
  AgentGroup,
  AlertRuleScope,
  AppBlockRule,
  ScheduledScriptSchedule,
} from "@/api/types";
import { scopeLabels } from "./alertRuleSummary";
import { DAY_OPTIONS, minuteToTime } from "../rulesUtils";
import { joinOvernight, type ScheduleWindow } from "./scheduleRows";

type ScopeLike = { kind: string; group_id?: string | null; agent_id?: string | null };

/** Every place a rule or script applies, one label each ("All devices", "Group · Lab", "Agent · Alpha"). */
export function ruleScopeLabels(
  scopes: ScopeLike[] | undefined,
  groups: AgentGroup[],
  agentsById: Record<string, Agent>,
): string[] {
  const cleaned = (scopes ?? []).map((s) => ({
    kind: s.kind,
    group_id: s.group_id ?? undefined,
    agent_id: s.agent_id ?? undefined,
  }));
  return scopeLabels(cleaned as AlertRuleScope[], groups, agentsById);
}

/**
 * Scope labels of an app block rule. The list endpoint returns every scope row; a rule loaded for one
 * agent only carries a summarised `scope_kind`.
 */
export function appBlockScopeLabels(
  rule: AppBlockRule,
  groups: AgentGroup[],
  agentsById: Record<string, Agent>,
): string[] {
  if (!rule.scopes || rule.scopes.length === 0) {
    const kind = rule.scope_kind ?? "agent";
    return [kind === "all" ? "All devices" : kind === "group" ? "A group" : "This device"];
  }
  return ruleScopeLabels(rule.scopes, groups, agentsById);
}

const DAY_SHORT = DAY_OPTIONS.map((o) => o.label.slice(0, 3));
/** Monday first, the way a week reads. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const timeRange = (start: number, end: number) =>
  start === 0 && end >= 1439 ? "all day" : `${minuteToTime(start)}–${minuteToTime(end)}`;

/** "Mon–Fri" for consecutive days, "Mon, Wed" otherwise. */
function dayList(days: number[]): string {
  const order = WEEK_ORDER.filter((d) => days.includes(d));
  const runs: number[][] = [];
  for (const d of order) {
    const last = runs[runs.length - 1];
    if (last && WEEK_ORDER.indexOf(last[last.length - 1]) + 1 === WEEK_ORDER.indexOf(d))
      last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) =>
      r.length >= 3
        ? `${DAY_SHORT[r[0]]}–${DAY_SHORT[r[r.length - 1]]}`
        : r.map((d) => DAY_SHORT[d]).join(", "),
    )
    .join(", ");
}

/**
 * The active hours of an app or internet block rule, one label per distinct time range. An empty schedule
 * means the rule applies all the time. Times are in each device's own clock.
 */
export function scheduleLabels(schedules: ScheduleWindow[] | undefined | null): string[] {
  if (!schedules || schedules.length === 0) return ["Always"];
  const spans = joinOvernight(schedules);
  const sameDay = new Map<string, number[]>();
  const overnight: string[] = [];
  for (const s of spans) {
    if (s.endDay === s.day) {
      const key = timeRange(s.start, s.end);
      sameDay.set(key, [...(sameDay.get(key) ?? []), s.day]);
    } else {
      overnight.push(
        `${DAY_SHORT[s.day]} ${minuteToTime(s.start)} → ${DAY_SHORT[s.endDay]} ${minuteToTime(s.end)}`,
      );
    }
  }
  return [...[...sameDay].map(([range, days]) => `${dayList(days)} ${range}`), ...overnight];
}

/** What a scheduled rule does when it is on: when it applies, in the device's own time. */
export function scheduleCaption(schedules: ScheduleWindow[] | undefined | null): string {
  return !schedules || schedules.length === 0 ? "Always" : "Only during set hours (device time)";
}

/** Plural-aware count line shown above a list: "3 rules · 2 on". */
export function enabledCount(items: { enabled: boolean }[], noun: string): string {
  const on = items.filter((i) => i.enabled).length;
  const word = items.length === 1 ? noun : `${noun}s`;
  return on === items.length
    ? `${items.length} ${word} · all on`
    : `${items.length} ${word} · ${on} on`;
}

/** When a script fires, one label per schedule ("Every day at 03:00", "Mondays at 02:00", "Every hour at :15"). */
export function scriptScheduleLabels(
  schedules: ScheduledScriptSchedule[] | undefined | null,
): string[] {
  if (!schedules || schedules.length === 0) return ["Never (run now only)"];
  return schedules.map((s) => {
    if (s.frequency === "hourly") return `Every hour at :${String(s.fire_minute).padStart(2, "0")}`;
    if (s.frequency === "daily") return `Every day at ${minuteToTime(s.fire_minute)}`;
    const day =
      s.day_of_week != null
        ? DAY_OPTIONS.find((o) => o.value === String(s.day_of_week))?.label
        : undefined;
    return `${day ? `${day}s` : "Weekly"} at ${minuteToTime(s.fire_minute)}`;
  });
}

const SHELL_LABEL: Record<string, string> = { powershell: "PowerShell", cmd: "CMD", bash: "Bash" };

export const shellLabel = (shell: string): string => SHELL_LABEL[shell] ?? shell;

export type RunTone = "ok" | "bad" | "wait" | "muted";

/**
 * What the server's script status words mean. `fired` is only "handed to the device": the result arrives later
 * as success, failed or error, so it is never reported as having run.
 */
export function runStatus(status: string): { label: string; tone: RunTone } {
  switch (status) {
    case "success":
      return { label: "Succeeded", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    case "error":
      return { label: "Couldn’t run", tone: "bad" };
    case "fired":
      return { label: "Sent, no result yet", tone: "wait" };
    case "skipped_offline":
      return { label: "Skipped, device offline", tone: "muted" };
    default:
      return { label: status || "Unknown", tone: "muted" };
  }
}

export const RUN_TONE_CLASS: Record<RunTone, string> = {
  ok: "text-success",
  bad: "text-destructive",
  wait: "text-foreground",
  muted: "text-muted-foreground",
};

/** Worst first, so a mixed run reads by its problem. */
const STATUS_ORDER = ["error", "failed", "fired", "skipped_offline", "success"];

/** The outcome of one fire across the devices it went to: "1 failed, 4 succeeded". */
export function runCountsSummary(counts: Record<string, number>): { text: string; tone: RunTone } {
  const keys = Object.keys(counts).sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (keys.length === 0) return { text: "No result", tone: "muted" };
  const WORD: Record<string, string> = {
    success: "succeeded",
    failed: "failed",
    error: "couldn’t run",
    fired: "waiting for a result",
    skipped_offline: "offline, skipped",
  };
  const total = keys.reduce((n, k) => n + counts[k], 0);
  if (keys.length === 1) {
    const only = runStatus(keys[0]);
    return {
      text: total === 1 ? only.label : `${only.label} on ${total} devices`,
      tone: only.tone,
    };
  }
  const text = keys.map((k) => `${counts[k]} ${WORD[k] ?? k}`).join(", ");
  return { text, tone: runStatus(keys[0]).tone };
}
