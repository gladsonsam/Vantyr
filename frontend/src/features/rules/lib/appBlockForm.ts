import type { api } from "@/api";
import type { AppBlockRule, AppBlockRuleScope } from "@/api/types";
import { emptyScopeRow, formScopesToApi, scopesToForm, type ScopeFormRow } from "../rulesUtils";
import { emptyScheduleRow, expandScheduleRows, scheduleToRows, type ScheduleFormRow } from "./scheduleRows";

export interface AppBlockForm {
  exe_pattern: string;
  match_mode: "contains" | "exact";
  label: string;
  scopes: ScopeFormRow[];
  scheduled: boolean;
  schedule_rows: ScheduleFormRow[];
}

export type AppBlockRuleBody = Parameters<typeof api.appBlockRulesCreate>[0];

export function defaultAppBlockForm(): AppBlockForm {
  return {
    exe_pattern: "",
    match_mode: "contains",
    label: "",
    scopes: [emptyScopeRow()],
    scheduled: false,
    schedule_rows: [emptyScheduleRow()],
  };
}

/** Form values for an existing rule; `contextAgentId` seeds the scope of a legacy single-agent rule. */
export function appBlockRuleToForm(r: AppBlockRule, contextAgentId: string): AppBlockForm {
  const scopes = r.scopes && r.scopes.length > 0 ? r.scopes : [{ kind: r.scope_kind ?? "agent", group_id: "", agent_id: contextAgentId }];
  const schedules = Array.isArray(r.schedules) ? r.schedules : [];
  return {
    exe_pattern: r.exe_pattern,
    match_mode: r.match_mode,
    label: r.name || "",
    scopes: scopesToForm(scopes as unknown as AppBlockRuleScope[]),
    scheduled: schedules.length > 0,
    schedule_rows: scheduleToRows(schedules),
  };
}

/** The request body for a form that already passed validation. */
export function appBlockFormToBody(form: AppBlockForm): AppBlockRuleBody {
  const pattern = form.exe_pattern.trim();
  return {
    name: form.label.trim() || pattern,
    exe_pattern: pattern,
    match_mode: form.match_mode,
    scopes: formScopesToApi(form.scopes).map((s) => ({
      kind: s.kind,
      group_id: s.group_id,
      agent_id: s.agent_id,
    })),
    schedules: form.scheduled ? expandScheduleRows(form.schedule_rows) : [],
  };
}
