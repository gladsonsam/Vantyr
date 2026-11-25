import { describe, expect, it } from "vitest";
import type { ScheduledScript } from "@/api/types";
import { toLastRuns } from "@/features/rules/hooks/useScheduledScriptRuns";
import { defaultScheduledScriptForm, scheduledScriptFormToBody, scheduledScriptSchema, scheduledScriptToForm, scriptFireMinute } from "@/features/rules/lib/scheduledScriptForm";

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
      scopes: [{ kind: "group", group_id: "g1", agent_id: null }],
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
      1: { time: "2026-01-02T10:00:00Z", counts: { failed: 1 } },
      2: { time: "2026-01-01T09:00:00Z", counts: { ok: 1 } },
    });
  });
});

describe("toLastRuns by device", () => {
  it("counts how the newest fire went on every device it was sent to", () => {
    const runs = toLastRuns({
      rows: [
        { script_id: 1, agent_id: "a", status: "success", expected_fire_time: "2026-01-02T10:00:00Z" },
        { script_id: 1, agent_id: "b", status: "failed", expected_fire_time: "2026-01-02T10:00:00Z" },
        { script_id: 1, agent_id: "c", status: "success", expected_fire_time: "2026-01-02T10:00:00Z" },
        { script_id: 1, agent_id: "a", status: "error", expected_fire_time: "2026-01-01T10:00:00Z" },
      ] as never,
    });
    expect(runs[1]).toEqual({ time: "2026-01-02T10:00:00Z", counts: { success: 2, failed: 1 } });
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

describe("scheduled script schedule times", () => {
  it("reads a minute for hourly scripts and HH:MM for the others", () => {
    expect(scriptFireMinute({ frequency: "hourly", timeStr: "30" })).toBe(30);
    expect(scriptFireMinute({ frequency: "hourly", timeStr: "60" })).toBeNull();
    expect(scriptFireMinute({ frequency: "hourly", timeStr: "12:30" })).toBeNull();
    expect(scriptFireMinute({ frequency: "daily", timeStr: "06:05" })).toBe(365);
    expect(scriptFireMinute({ frequency: "weekly", timeStr: "24:00" })).toBeNull();
    expect(scriptFireMinute({ frequency: "daily", timeStr: "soon" })).toBeNull();
  });

  it("sends the typed minute of an hourly script rather than 0, and shows a stored minute as a number", () => {
    const body = scheduledScriptFormToBody({ ...defaultScheduledScriptForm(), schedules: [{ frequency: "hourly", fire_minute: 0, timeStr: "30" }] });
    expect(body.schedules).toEqual([{ frequency: "hourly", fire_minute: 30, day_of_week: undefined }]);
    expect(scheduledScriptToForm(script({ schedules: [{ frequency: "hourly", day_of_week: null, fire_minute: 15 }] })).schedules[0].timeStr).toBe("15");
  });

  it("sends Monday for a weekly schedule whose day was never touched, as the box shows", () => {
    const body = scheduledScriptFormToBody({ ...defaultScheduledScriptForm(), schedules: [{ frequency: "weekly", fire_minute: 0, timeStr: "02:00" }] });
    expect(body.schedules).toEqual([{ frequency: "weekly", fire_minute: 120, day_of_week: 1 }]);
  });
});

describe("scheduledScriptSchema checks the server would make", () => {
  const valid = { ...defaultScheduledScriptForm(), name: "Health", script: "dir" };
  const issues = (patch: object) => scheduledScriptSchema.safeParse({ ...valid, ...patch }).error?.issues.map((i) => [i.path[0], i.message]);

  it("keeps the timeout within 5 to 300 seconds", () => {
    expect(issues({ timeout_secs: "4" })).toEqual([["timeout_secs", "Timeout must be 5 to 300 seconds."]]);
    expect(issues({ timeout_secs: "301" })).toEqual([["timeout_secs", "Timeout must be 5 to 300 seconds."]]);
    expect(issues({ timeout_secs: "" })).toEqual([["timeout_secs", "Timeout must be 5 to 300 seconds."]]);
    expect(issues({ timeout_secs: "300" })).toBeUndefined();
  });

  it("names a scope row that picks nothing and a schedule that can't be read", () => {
    expect(issues({ scopes: [{ kind: "group", group_id: "", agent_id: "" }] })).toEqual([["scopes", "Each group scope must select a group"]]);
    expect(issues({ schedules: [{ frequency: "hourly", fire_minute: 0, timeStr: "75" }] })).toEqual([["schedules", "Schedule 1: enter a minute from 0 to 59."]]);
    expect(issues({ schedules: [{ frequency: "daily", fire_minute: 0, timeStr: "late" }] })).toEqual([["schedules", "Schedule 1: enter a time as HH:MM."]]);
  });
});
