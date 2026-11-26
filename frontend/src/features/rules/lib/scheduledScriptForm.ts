import { z } from "zod";
import type { api } from "@/api";
import type { ScheduledScript, ScheduledScriptScope } from "@/api/types";
import { emptyScopeRow, formScopesToApi, minuteToTime, timeToMinute } from "../rulesUtils";
import { scopesProblem } from "./scopeRows";

/** The server accepts a script timeout of 5 to 300 seconds. */
export const TIMEOUT_MIN_SECS = 5;
export const TIMEOUT_MAX_SECS = 300;

const scriptScheduleRowSchema = z.object({
  frequency: z.enum(["hourly", "daily", "weekly"]),
  day_of_week: z.number().nullish(),
  fire_minute: z.number(),
  /** What the time box shows ("HH:MM", or a minute for hourly); empty falls back to `fire_minute`. */
  timeStr: z.string(),
});

/**
 * The minute a typed schedule time stands for, or null when it can't be read: a minute from 0 to 59 for an
 * hourly script, otherwise HH:MM within one day.
 */
export function scriptFireMinute(
  row: Pick<ScriptScheduleRow, "frequency" | "timeStr">,
): number | null {
  const text = row.timeStr.trim();
  if (row.frequency === "hourly") {
    const minute = /^\d{1,2}$/.test(text) ? Number(text) : null;
    return minute !== null && minute <= 59 ? minute : null;
  }
  const minute = timeToMinute(text);
  return minute !== null && minute < 1440 ? minute : null;
}

const TIME_HINT = {
  hourly: "a minute from 0 to 59",
  daily: "a time as HH:MM",
  weekly: "a time as HH:MM",
} as const;

export const scheduledScriptSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    shell: z.string(),
    // The script is sent as typed, so check for content without trimming the value.
    script: z.string().refine((value) => value.trim().length > 0, "Script is required"),
    /** Kept as typed; parsed when the body is built. */
    timeout_secs: z.string(),
    scopes: z.array(
      z.object({
        kind: z.enum(["all", "group", "agent"]),
        group_id: z.string(),
        agent_id: z.string(),
      }),
    ),
    schedules: z.array(scriptScheduleRowSchema),
  })
  .superRefine((form, ctx) => {
    if (
      !/^\d+$/.test(form.timeout_secs.trim()) ||
      Number(form.timeout_secs) < TIMEOUT_MIN_SECS ||
      Number(form.timeout_secs) > TIMEOUT_MAX_SECS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["timeout_secs"],
        message: `Timeout must be ${TIMEOUT_MIN_SECS} to ${TIMEOUT_MAX_SECS} seconds.`,
      });
    }
    const scopes = scopesProblem(form.scopes);
    if (scopes) ctx.addIssue({ code: "custom", path: ["scopes"], message: scopes });
    const bad = form.schedules.findIndex((row) => scriptFireMinute(row) === null);
    if (bad >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["schedules"],
        message: `Schedule ${bad + 1}: enter ${TIME_HINT[form.schedules[bad].frequency]}.`,
      });
    }
  });

export type ScheduledScriptForm = z.infer<typeof scheduledScriptSchema>;
export type ScriptScheduleRow = ScheduledScriptForm["schedules"][number];

export type ScheduledScriptBody = Parameters<typeof api.scheduledScriptsCreate>[0];

export function defaultScheduleRow(): ScriptScheduleRow {
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
  const scopes: ScheduledScriptScope[] =
    r.scopes && r.scopes.length > 0 ? r.scopes : [{ kind: "all" }];
  const schedules = Array.isArray(r.schedules) ? r.schedules : [];
  return {
    name: r.name,
    shell: r.shell,
    script: r.script,
    timeout_secs: String(r.timeout_secs),
    scopes: scopes.map((s) => ({
      kind: s.kind,
      group_id: s.group_id ?? "",
      agent_id: s.agent_id ?? "",
    })),
    schedules:
      schedules.length > 0
        ? schedules.map((s) => ({
            ...s,
            timeStr: s.frequency === "hourly" ? String(s.fire_minute) : minuteToTime(s.fire_minute),
          }))
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
    scopes: formScopesToApi(form.scopes).map((s) => ({
      kind: s.kind,
      group_id: s.group_id,
      agent_id: s.agent_id,
    })),
    schedules: form.schedules.map((s) => ({
      frequency: s.frequency,
      fire_minute: s.timeStr ? (scriptFireMinute(s) ?? 0) : s.fire_minute,
      day_of_week: s.frequency === "weekly" ? (s.day_of_week ?? 1) : undefined,
    })),
  };
}
