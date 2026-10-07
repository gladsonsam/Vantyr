import { describe, expect, it } from "vitest";
import type { AppBlockRule } from "@/api/types";
import { appBlockFormToBody, appBlockRuleToForm, appBlockSchema, defaultAppBlockForm } from "./appBlockForm";

const rule = (patch: Partial<AppBlockRule>): AppBlockRule => ({
  id: 1, name: "", exe_pattern: "tiktok.exe", match_mode: "contains", enabled: true, scopes: [], schedules: [],
  ...patch,
} as AppBlockRule);

describe("app block form mapping", () => {
  it("defaults to an unscheduled all-agents rule", () => {
    const form = defaultAppBlockForm();
    expect(form).toMatchObject({ exe_pattern: "", match_mode: "contains", scheduled: false });
    expect(form.scopes).toEqual([{ kind: "all", group_id: "", agent_id: "" }]);
  });

  it("labels a rule with its exe name when no label was typed", () => {
    const body = appBlockFormToBody({ ...defaultAppBlockForm(), exe_pattern: "  tiktok.exe " });
    expect(body).toMatchObject({ name: "tiktok.exe", exe_pattern: "tiktok.exe", schedules: [] });
  });

  it("keeps a typed label and expands enabled schedule rows", () => {
    const body = appBlockFormToBody({
      ...defaultAppBlockForm(),
      exe_pattern: "game.exe",
      label: " Games ",
      scheduled: true,
      schedule_rows: [{ day_of_week: 5, start: "22:00", end: "06:00" }],
    });
    expect(body.name).toBe("Games");
    expect(body.schedules).toEqual([
      { day_of_week: 5, start_minute: 1320, end_minute: 1440 },
      { day_of_week: 6, start_minute: 0, end_minute: 360 },
    ]);
  });

  it("ignores schedule rows while the schedule is switched off", () => {
    const body = appBlockFormToBody({ ...defaultAppBlockForm(), exe_pattern: "a.exe", scheduled: false });
    expect(body.schedules).toEqual([]);
  });

  it("restores a stored schedule into editable rows", () => {
    const form = appBlockRuleToForm(rule({ name: "Label", schedules: [{ day_of_week: 2, start_minute: 60, end_minute: 120 }] }), "agent-1");
    expect(form).toMatchObject({ label: "Label", scheduled: true });
    expect(form.schedule_rows).toEqual([{ day_of_week: 2, start: "01:00", end: "02:00" }]);
  });

  it("scopes a legacy rule with no scopes to the context agent", () => {
    const form = appBlockRuleToForm(rule({ scopes: [], scope_kind: "agent" }), "agent-1");
    expect(form.scopes).toEqual([{ kind: "agent", group_id: "", agent_id: "agent-1" }]);
  });
});

describe("app block schema", () => {
  it("requires an exe name, ignoring surrounding spaces", () => {
    const result = appBlockSchema.safeParse({ ...defaultAppBlockForm(), exe_pattern: "   " });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([{ path: ["exe_pattern"], message: "EXE name is required." }]);
  });

  it("accepts a named exe and trims it", () => {
    const result = appBlockSchema.safeParse({ ...defaultAppBlockForm(), exe_pattern: " tiktok.exe " });
    expect(result.data?.exe_pattern).toBe("tiktok.exe");
  });
});
