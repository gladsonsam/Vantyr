import { z } from "zod";

export const groupSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  description: z.string().trim(),
});
export type GroupValues = z.infer<typeof groupSchema>;

const scopeRowSchema = z.object({
  kind: z.enum(["all", "group", "agent"]),
  group_id: z.string(),
  agent_id: z.string(),
});
export type RuleScopeRow = z.infer<typeof scopeRowSchema>;

export const groupRuleSchema = z
  .object({
    name: z.string().trim(),
    channel: z.enum(["url", "keys", "url_category", "agent_offline", "resource"]),
    pattern: z.string().trim().min(1, "Pattern is required"),
    match_mode: z.enum(["substring", "regex"]),
    case_insensitive: z.boolean(),
    cooldown_secs: z.number().min(0),
    enabled: z.boolean(),
    take_screenshot: z.boolean(),
    scopes: z.array(scopeRowSchema),
  })
  .superRefine((rule, ctx) => {
    for (const row of rule.scopes) {
      if (row.kind === "group" && !row.group_id.trim()) {
        ctx.addIssue({ code: "custom", path: ["scopes"], message: "Each group scope must select a group" });
        return;
      }
      if (row.kind === "agent" && !row.agent_id.trim()) {
        ctx.addIssue({ code: "custom", path: ["scopes"], message: "Each agent scope must select an agent" });
        return;
      }
    }
  });
export type GroupRuleValues = z.infer<typeof groupRuleSchema>;
