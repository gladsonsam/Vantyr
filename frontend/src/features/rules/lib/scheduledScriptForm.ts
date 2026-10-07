import type { api } from "@/api";
import type { ScheduledScript, ScheduledScriptSchedule } from "@/api/types";
import { emptyScopeRow, formScopesToApi, minuteToTime, timeToMinute, type ScopeFormRow } from "../rulesUtils";

export interface ScriptScheduleRow {
  frequency: ScheduledScriptSchedule["frequency"];
  day_of_week?: number | null;
  fire_minute: number;
  /** What the time box shows ("HH:MM", or a minute for hourly); empty falls back to `fire_minute`. */
  timeStr: string;
}

export interface ScheduledScriptForm {
  name: string;
  shell: string;
  script: string;
  /** Kept as typed; parsed when the body is built. */
  timeout_secs: string;
  scopes: ScopeFormRow[];
  schedules: ScriptScheduleRow[];
}

export type ScheduledScriptBody = Parameters<typeof api.scheduledScriptsCreate>[0];

function defaultScheduleRow(): ScriptScheduleRow {
  return { frequency: "daily", fire_minute: 0, timeStr: "00:00" };
}

export function defaultScheduledScriptForm(): ScheduledScriptForm {
  return {
    name: "",
    shell: "powershell",
    script: "",
    timeout_secs: "120",
    scopes: [emptyScopeRow()],
    schedules: [defaultScheduleRow()],
  };
}

export function scheduledScriptToForm(r: ScheduledScript): ScheduledScriptForm {
  const scopes = r.scopes && r.scopes.length > 0 ? r.scopes : [{ kind: "all" as const }];
  const schedules = Array.isArray(r.schedules) ? r.schedules : [];
  return {
    name: r.name,
    shell: r.shell,
    script: r.script,
    timeout_secs: String(r.timeout_secs),
    scopes: scopes.map((s) => ({ kind: s.kind, group_id: s.group_id ?? "", agent_id: s.agent_id ?? "" })),
    schedules: schedules.length > 0
      ? schedules.map((s) => ({ ...s, timeStr: minuteToTime(s.fire_minute) }))
      : [defaultScheduleRow()],
  };
}

/** The request body for a form that already passed validation. */
export function scheduledScriptFormToBody(form: ScheduledScriptForm): ScheduledScriptBody {
  return {
    name: form.name.trim(),
    shell: form.shell,
    script: form.script,
    timeout_secs: Math.max(1, parseInt(form.timeout_secs, 10) || 120),
    scopes: formScopesToApi(form.scopes).map((s) => ({ kind: s.kind, group_id: s.group_id, agent_id: s.agent_id })),
    schedules: form.schedules.map((s) => ({
      frequency: s.frequency,
      fire_minute: s.timeStr ? (timeToMinute(s.timeStr) ?? 0) : s.fire_minute,
      day_of_week: s.frequency === "weekly" ? s.day_of_week : undefined,
    })),
  };
}
