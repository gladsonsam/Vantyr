import { z } from "zod";
import type { api } from "@/api";
import { emptyScheduleRow, expandScheduleRows, scheduleRowSchema } from "@/features/rules/lib/scheduleRows";

export type MatchMode = "contains" | "exact";

/** The protected executable a pattern would hit, if any (`protectedExes` is lowercase). */
export function protectedHit(pattern: string, mode: MatchMode, protectedExes: string[]): string | null {
  const pat = pattern.trim().toLowerCase();
  if (!pat) return null;
  for (const p of protectedExes) {
    const hit = mode === "exact" ? pat === p : p.includes(pat);
    if (hit) return p;
  }
  return null;
}

export const protectedMessage = (exe: string) => `'${exe}' is protected and can't be blocked.`;

/** The quick "block this app" form on the remote Control tab; `protectedExes` are refused. */
export function createQuickAppBlockSchema(protectedExes: string[]) {
  return z
    .object({
      exe_pattern: z.string().trim().min(1, "EXE name is required."),
      match_mode: z.enum(["contains", "exact"]),
      label: z.string(),
      apply_to_all: z.boolean(),
      scheduled: z.boolean(),
      schedule_rows: z.array(scheduleRowSchema),
    })
    .superRefine((form, ctx) => {
      const hit = protectedHit(form.exe_pattern, form.match_mode, protectedExes);
      if (hit) {
        ctx.addIssue({ code: "custom", path: ["exe_pattern"], message: protectedMessage(hit) });
        return;
      }
      if (form.scheduled && expandScheduleRows(form.schedule_rows).length === 0) {
        ctx.addIssue({ code: "custom", path: ["schedule_rows"], message: "Add a valid window (end after start)." });
      }
    });
}

export type QuickAppBlockValues = z.infer<ReturnType<typeof createQuickAppBlockSchema>>;

export const DEFAULT_QUICK_APP_BLOCK: QuickAppBlockValues = {
  exe_pattern: "",
  match_mode: "contains",
  label: "",
  apply_to_all: false,
  scheduled: false,
  schedule_rows: [emptyScheduleRow()],
};

/** The request body for a valid form: this device only, or every device. */
export function quickAppBlockToBody(values: QuickAppBlockValues, agentId: string): Parameters<typeof api.appBlockRulesCreate>[0] {
  const pattern = values.exe_pattern.trim();
  return {
    name: values.label.trim() || pattern,
    exe_pattern: pattern,
    match_mode: values.match_mode,
    scopes: values.apply_to_all ? [{ kind: "all" as const }] : [{ kind: "agent" as const, agent_id: agentId }],
    schedules: values.scheduled ? expandScheduleRows(values.schedule_rows) : undefined,
  };
}
