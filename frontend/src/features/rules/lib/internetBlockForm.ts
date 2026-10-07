import { z } from "zod";
import type { api } from "@/api";
import { emptyScopeRow } from "../rulesUtils";
import { emptyScheduleRow, expandScheduleRows, scheduleRowSchema } from "./scheduleRows";

export const SCHEDULE_NEEDS_WINDOW = "Schedule is enabled but no valid windows were provided (use HH:MM).";

export const internetBlockSchema = z
  .object({
    name: z.string(),
    scopes: z.array(z.object({
      kind: z.enum(["all", "group", "agent"]),
      group_id: z.string(),
      agent_id: z.string(),
    })),
    scheduled: z.boolean(),
    schedule_rows: z.array(scheduleRowSchema),
  })
  .superRefine((form, ctx) => {
    if (form.scheduled && expandScheduleRows(form.schedule_rows).length === 0) {
      ctx.addIssue({ code: "custom", path: ["schedule_rows"], message: SCHEDULE_NEEDS_WINDOW });
    }
  });

export type InternetBlockForm = z.infer<typeof internetBlockSchema>;

/** Editing an existing rule's schedule only touches the windows. */
export const internetScheduleSchema = z.object({ schedule_rows: z.array(scheduleRowSchema) });
export type InternetScheduleForm = z.infer<typeof internetScheduleSchema>;

export type InternetBlockRuleBody = Parameters<typeof api.internetBlockRulesCreate>[0];

export function defaultInternetBlockForm(): InternetBlockForm {
  return { name: "", scopes: [emptyScopeRow()], scheduled: false, schedule_rows: [emptyScheduleRow()] };
}

/** The request body for a form that already passed validation. */
export function internetBlockFormToBody(form: InternetBlockForm): InternetBlockRuleBody {
  return {
    name: form.name.trim(),
    scopes: form.scopes.map((s) => ({ kind: s.kind, group_id: s.group_id || undefined, agent_id: s.agent_id || undefined })),
    schedules: form.scheduled ? expandScheduleRows(form.schedule_rows) : undefined,
  };
}
