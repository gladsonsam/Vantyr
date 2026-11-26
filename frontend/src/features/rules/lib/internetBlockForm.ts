import { z } from "zod";
import type { api } from "@/api";
import { emptyScopeRow } from "../rulesUtils";
import {
  emptyScheduleRow,
  expandScheduleRows,
  scheduleRowSchema,
  scheduleRowsProblem,
  SCHEDULE_NEEDS_WINDOW,
} from "./scheduleRows";
import { scopesProblem } from "./scopeRows";

export { SCHEDULE_NEEDS_WINDOW };

export const internetBlockSchema = z
  .object({
    name: z.string(),
    scopes: z.array(
      z.object({
        kind: z.enum(["all", "group", "agent"]),
        group_id: z.string(),
        agent_id: z.string(),
      }),
    ),
    scheduled: z.boolean(),
    schedule_rows: z.array(scheduleRowSchema),
  })
  .superRefine((form, ctx) => {
    const scopes = scopesProblem(form.scopes);
    if (scopes) ctx.addIssue({ code: "custom", path: ["scopes"], message: scopes });
    const schedule = form.scheduled ? scheduleRowsProblem(form.schedule_rows) : null;
    if (schedule) ctx.addIssue({ code: "custom", path: ["schedule_rows"], message: schedule });
  });

export type InternetBlockForm = z.infer<typeof internetBlockSchema>;

/** Editing an existing rule's schedule only touches the windows; without "only during set hours" it applies always. */
export const internetScheduleSchema = z
  .object({ scheduled: z.boolean(), schedule_rows: z.array(scheduleRowSchema) })
  .superRefine((form, ctx) => {
    const schedule = form.scheduled ? scheduleRowsProblem(form.schedule_rows) : null;
    if (schedule) ctx.addIssue({ code: "custom", path: ["schedule_rows"], message: schedule });
  });
export type InternetScheduleForm = z.infer<typeof internetScheduleSchema>;

/** Windows to store for the schedule form: none means the rule applies all the time. */
export const internetScheduleWindows = (form: InternetScheduleForm) =>
  form.scheduled ? expandScheduleRows(form.schedule_rows) : [];

export type InternetBlockRuleBody = Parameters<typeof api.internetBlockRulesCreate>[0];

export function defaultInternetBlockForm(): InternetBlockForm {
  return {
    name: "",
    scopes: [emptyScopeRow()],
    scheduled: false,
    schedule_rows: [emptyScheduleRow()],
  };
}

/** The request body for a form that already passed validation. */
export function internetBlockFormToBody(form: InternetBlockForm): InternetBlockRuleBody {
  return {
    name: form.name.trim(),
    scopes: form.scopes.map((s) => ({
      kind: s.kind,
      group_id: s.group_id || undefined,
      agent_id: s.agent_id || undefined,
    })),
    schedules: form.scheduled ? expandScheduleRows(form.schedule_rows) : undefined,
  };
}
