import { z } from "zod";
import type { api } from "@/api";
import type { ScheduledScript, ScheduledScriptScope } from "@/api/types";
import { emptyScopeRow, formScopesToApi, minuteToTime, timeToMinute } from "../rulesUtils";

const scriptScheduleRowSchema = z.object({
  frequency: z.enum(["hourly", "daily", "weekly"]),
  day_of_week: z.number().nullish(),
  fire_minute: z.number(),
  /** What the time box shows ("HH:MM", or a minute for hourly); empty falls back to `fire_minute`. */
  timeStr: z.string(),
});

export const scheduledScriptSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  shell: z.string(),
  // The script is sent as typed, so check for content without trimming the value.
  script: z.string().refine((value) => value.trim().length > 0, "Script is required"),
  /** Kept as typed; parsed when the body is built. */
  timeout_secs: z.string(),
  scopes: z.array(z.object({
    kind: z.enum(["all", "group", "agent"]),
    group_id: z.string(),
    agent_id: z.string(),
  })),
  schedules: z.array(scriptScheduleRowSchema),
});

export type ScheduledScriptForm = z.infer<typeof scheduledScriptSchema>;
export type ScriptScheduleRow = ScheduledScriptForm["schedules"][number];

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
  const scopes: ScheduledScriptScope[] = r.scopes && r.scopes.length > 0 ? r.scopes : [{ kind: "all" }];
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
