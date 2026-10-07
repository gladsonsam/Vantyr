import { describe, expect, it } from "vitest";
import { groupRuleSchema, groupSchema } from "./groupSchemas";

const rule = {
  name: " Videos ", channel: "url" as const, pattern: " youtube.com ", match_mode: "substring" as const,
  case_insensitive: true, cooldown_secs: 300, enabled: true, take_screenshot: false,
  scopes: [{ kind: "all" as const, group_id: "", agent_id: "" }],
};

describe("groupSchema", () => {
  it("requires a name and trims both fields", () => {
    expect(groupSchema.safeParse({ name: "  ", description: "" }).success).toBe(false);
    expect(groupSchema.parse({ name: " Lab ", description: " 2nd floor " })).toEqual({ name: "Lab", description: "2nd floor" });
  });
});

describe("groupRuleSchema", () => {
  it("trims the name and pattern", () => {
    const parsed = groupRuleSchema.parse(rule);
    expect(parsed.name).toBe("Videos");
    expect(parsed.pattern).toBe("youtube.com");
  });

  it("requires a pattern", () => {
    expect(groupRuleSchema.safeParse({ ...rule, pattern: " " }).error?.issues[0]).toMatchObject({ path: ["pattern"], message: "Pattern is required" });
  });

  it("requires a group or agent to be picked for group and agent scopes", () => {
    const group = groupRuleSchema.safeParse({ ...rule, scopes: [{ kind: "group", group_id: "", agent_id: "" }] });
    expect(group.error?.issues[0]).toMatchObject({ path: ["scopes"], message: "Each group scope must select a group" });
    const agent = groupRuleSchema.safeParse({ ...rule, scopes: [{ kind: "agent", group_id: "", agent_id: " " }] });
    expect(agent.error?.issues[0]).toMatchObject({ path: ["scopes"], message: "Each agent scope must select an agent" });
    expect(groupRuleSchema.safeParse({ ...rule, scopes: [{ kind: "group", group_id: "g1", agent_id: "" }] }).success).toBe(true);
  });
});
