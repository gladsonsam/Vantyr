import { describe, expect, it } from "vitest";
import type { ScheduledScript } from "@/api/types";
import { toLastRuns } from "../hooks/useScheduledScriptRuns";
import { defaultScheduledScriptForm, scheduledScriptFormToBody, scheduledScriptSchema, scheduledScriptToForm } from "./scheduledScriptForm";

const script = (patch: Partial<ScheduledScript>): ScheduledScript => ({
  id: 4, name: "Health", shell: "cmd", script: "dir", timeout_secs: 30, enabled: true, created_at: "", updated_at: "",
  scopes: [], schedules: [], ...patch,
});

describe("scheduled script form mapping", () => {
  it("starts as a daily midnight PowerShell script with a 120 second timeout", () => {
    const form = defaultScheduledScriptForm();
    expect(form).toMatchObject({ shell: "powershell", timeout_secs: "120" });
    expect(form.schedules).toEqual([{ frequency: "daily", fire_minute: 0, timeStr: "00:00" }]);
  });

  it("restores scopes and shows stored fire minutes as HH:MM", () => {
    const form = scheduledScriptToForm(script({
      scopes: [{ kind: "group", group_id: "g1" }],
      schedules: [{ frequency: "weekly", day_of_week: 3, fire_minute: 90 }],
    }));
    expect(form.scopes).toEqual([{ kind: "group", group_id: "g1", agent_id: "" }]);
    expect(form.schedules).toEqual([{ frequency: "weekly", day_of_week: 3, fire_minute: 90, timeStr: "01:30" }]);
    expect(form.timeout_secs).toBe("30");
  });

  it("defaults a script without scopes to all agents", () => {
    expect(scheduledScriptToForm(script({})).scopes).toEqual([{ kind: "all", group_id: "", agent_id: "" }]);
  });

  it("parses the typed time and only keeps the weekday for weekly schedules", () => {
    const body = scheduledScriptFormToBody({
      ...defaultScheduledScriptForm(),
      name: " Health ",
      schedules: [
        { frequency: "weekly", day_of_week: 2, fire_minute: 0, timeStr: "13:45" },
        { frequency: "daily", day_of_week: 2, fire_minute: 0, timeStr: "06:05" },
      ],
    });
    expect(body.name).toBe("Health");
    expect(body.schedules).toEqual([
      { frequency: "weekly", fire_minute: 825, day_of_week: 2 },
      { frequency: "daily", fire_minute: 365, day_of_week: undefined },
    ]);
  });

  it("falls back to the stored minute when the time box is cleared, and to 0 when unparsable", () => {
    const body = scheduledScriptFormToBody({
      ...defaultScheduledScriptForm(),
      schedules: [
        { frequency: "hourly", fire_minute: 15, timeStr: "" },
        { frequency: "hourly", fire_minute: 15, timeStr: "soon" },
      ],
    });
    expect(body.schedules.map((s) => s.fire_minute)).toEqual([15, 0]);
  });

  it("clamps the timeout to at least 1 and defaults an unparsable one to 120", () => {
    expect(scheduledScriptFormToBody({ ...defaultScheduledScriptForm(), timeout_secs: "-5" }).timeout_secs).toBe(1);
    expect(scheduledScriptFormToBody({ ...defaultScheduledScriptForm(), timeout_secs: "" }).timeout_secs).toBe(120);
    expect(scheduledScriptFormToBody({ ...defaultScheduledScriptForm(), timeout_secs: "45" }).timeout_secs).toBe(45);
  });
});

describe("toLastRuns", () => {
  it("keeps the latest expected fire time per script", () => {
    const runs = toLastRuns({
      rows: [
        { script_id: 1, status: "ok", expected_fire_time: "2026-01-01T10:00:00Z" },
        { script_id: 1, status: "failed", expected_fire_time: "2026-01-02T10:00:00Z" },
        { script_id: 2, status: "ok", expected_fire_time: "2026-01-01T09:00:00Z" },
        { script_id: 1, status: "ok", expected_fire_time: "2025-12-31T10:00:00Z" },
      ] as never,
    });
    expect(runs).toEqual({
      1: { status: "failed", time: "2026-01-02T10:00:00Z" },
      2: { status: "ok", time: "2026-01-01T09:00:00Z" },
    });
  });
});

describe("scheduledScriptSchema", () => {
  const valid = { ...defaultScheduledScriptForm(), name: "Health", script: "dir" };

  it("accepts a named script with code", () => {
    expect(scheduledScriptSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a name and script code, reporting both on their own fields", () => {
    const result = scheduledScriptSchema.safeParse({ ...valid, name: "  ", script: "\n " });
    expect(result.error?.issues.map((i) => [i.path[0], i.message])).toEqual([
      ["name", "Name is required"],
      ["script", "Script is required"],
    ]);
  });

  it("does not trim the script it will send", () => {
    expect(scheduledScriptSchema.parse({ ...valid, script: "  dir\n" }).script).toBe("  dir\n");
  });
});
