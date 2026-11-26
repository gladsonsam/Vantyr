import { describe, expect, it } from "bun:test";
import type { AlertRule } from "@/api/types";
import {
  alertRuleFormToBody,
  alertRuleSchema,
  alertRuleToForm,
  defaultAlertRuleForm,
} from "@/features/rules/lib/alertRuleForm";

const rule = (patch: Partial<AlertRule>): AlertRule => ({
  id: 1,
  name: "R",
  channel: "url",
  pattern: "youtube.com",
  match_mode: "substring",
  case_insensitive: true,
  cooldown_secs: 300,
  enabled: true,
  take_screenshot: false,
  scopes: [],
  ...patch,
});

describe("alert rule form mapping", () => {
  it("starts a new rule on the URL channel with one all-agents scope", () => {
    const form = defaultAlertRuleForm();
    expect(form.channel).toBe("url");
    expect(form.scopes).toEqual([{ kind: "all", group_id: "", agent_id: "" }]);
  });

  it("fills monitoring defaults and converts seconds to minutes when editing", () => {
    const form = alertRuleToForm(rule({ channel: "agent_offline", duration_secs: 600 }));
    expect(form.duration_mins).toBe(10);
    expect(form.metric).toBe("cpu_pct");
    expect(form.threshold).toBe(90);
    expect(
      alertRuleToForm(rule({ channel: "agent_offline", duration_secs: 10 })).duration_mins,
    ).toBe(1);
  });

  it("trims text and drops monitoring-only fields for pattern channels", () => {
    const body = alertRuleFormToBody({
      ...defaultAlertRuleForm(),
      name: "  Video ",
      pattern: " youtube.com ",
      threshold: 50,
    });
    expect(body).toMatchObject({
      name: "Video",
      pattern: "youtube.com",
      metric: null,
      comparator: null,
      threshold: null,
      duration_secs: null,
    });
  });

  it("sends resource settings and an empty pattern for the resource channel", () => {
    const body = alertRuleFormToBody({
      ...defaultAlertRuleForm(),
      channel: "resource",
      pattern: "ignored",
      metric: "mem_pct",
      comparator: "lt",
      threshold: 20,
      take_screenshot: true,
    });
    expect(body).toMatchObject({
      pattern: "",
      metric: "mem_pct",
      comparator: "lt",
      threshold: 20,
      duration_secs: null,
      take_screenshot: true,
    });
  });

  it("never takes a screenshot for agent_offline and sends the duration in seconds", () => {
    const body = alertRuleFormToBody({
      ...defaultAlertRuleForm(),
      channel: "agent_offline",
      take_screenshot: true,
      duration_mins: 7,
    });
    expect(body).toMatchObject({ take_screenshot: false, duration_secs: 420, metric: null });
  });

  it("maps each scope kind to its id field", () => {
    const body = alertRuleFormToBody({
      ...defaultAlertRuleForm(),
      scopes: [
        { kind: "all", group_id: "", agent_id: "" },
        { kind: "group", group_id: "g1", agent_id: "" },
        { kind: "agent", group_id: "", agent_id: "a1" },
      ],
    });
    expect(body.scopes).toEqual([
      { kind: "all", group_id: undefined, agent_id: undefined },
      { kind: "group", group_id: "g1", agent_id: undefined },
      { kind: "agent", group_id: undefined, agent_id: "a1" },
    ]);
  });
});

describe("alert rule schema", () => {
  it("requires a pattern on pattern channels, trimmed", () => {
    const result = alertRuleSchema.safeParse({ ...defaultAlertRuleForm(), pattern: "   " });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { path: ["pattern"], message: "Pattern is required" },
    ]);
  });

  it("does not need a pattern for monitoring channels", () => {
    expect(
      alertRuleSchema.safeParse({ ...defaultAlertRuleForm(), channel: "resource" }).success,
    ).toBe(true);
    expect(
      alertRuleSchema.safeParse({ ...defaultAlertRuleForm(), channel: "agent_offline" }).success,
    ).toBe(true);
  });

  it("accepts a filled-in pattern rule", () => {
    expect(
      alertRuleSchema.safeParse({ ...defaultAlertRuleForm(), pattern: "youtube.com" }).success,
    ).toBe(true);
  });

  it("requires each group or agent scope to name its target, as the server does", () => {
    const base = { ...defaultAlertRuleForm(), pattern: "x" };
    const group = alertRuleSchema.safeParse({
      ...base,
      scopes: [{ kind: "group", group_id: " ", agent_id: "" }],
    });
    expect(group.error?.issues).toMatchObject([
      { path: ["scopes"], message: "Each group scope must select a group" },
    ]);
    const agent = alertRuleSchema.safeParse({
      ...base,
      scopes: [
        { kind: "all", group_id: "", agent_id: "" },
        { kind: "agent", group_id: "", agent_id: "" },
      ],
    });
    expect(agent.error?.issues).toMatchObject([
      { path: ["scopes"], message: "Each agent scope must select an agent" },
    ]);
    expect(
      alertRuleSchema.safeParse({
        ...base,
        scopes: [
          { kind: "group", group_id: "g1", agent_id: "" },
          { kind: "agent", group_id: "", agent_id: "a1" },
        ],
      }).success,
    ).toBe(true);
  });
});
