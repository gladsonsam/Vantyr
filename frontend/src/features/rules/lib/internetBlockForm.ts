import type { api } from "@/api";
import { emptyScopeRow } from "../rulesUtils";
import { emptyScheduleRow, expandScheduleRows, type ScheduleFormRow } from "./scheduleRows";
import type { ScopeFormRow } from "../rulesUtils";

export interface InternetBlockForm {
  name: string;
  scopes: ScopeFormRow[];
  scheduled: boolean;
  schedule_rows: ScheduleFormRow[];
}

export type InternetBlockRuleBody = Parameters<typeof api.internetBlockRulesCreate>[0];

export const SCHEDULE_NEEDS_WINDOW = "Schedule is enabled but no valid windows were provided (use HH:MM).";

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
