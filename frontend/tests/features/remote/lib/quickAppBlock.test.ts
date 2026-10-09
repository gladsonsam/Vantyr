import { describe, expect, it } from "vitest";
import { createQuickAppBlockSchema, DEFAULT_QUICK_APP_BLOCK, protectedHit, quickAppBlockToBody } from "@/features/remote/lib/quickAppBlock";

const protectedExes = ["explorer.exe", "csrss.exe"];
const messages = (r: { error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message);

describe("protectedHit", () => {
  it("matches a substring in contains mode and the whole name in exact mode", () => {
    expect(protectedHit("explor", "contains", protectedExes)).toBe("explorer.exe");
    expect(protectedHit("explor", "exact", protectedExes)).toBeNull();
    expect(protectedHit(" CSRSS.exe ", "exact", protectedExes)).toBe("csrss.exe");
    expect(protectedHit("   ", "contains", protectedExes)).toBeNull();
  });
});

describe("quick app block schema", () => {
  const schema = createQuickAppBlockSchema(protectedExes);

  it("requires an EXE name", () => {
    expect(messages(schema.safeParse(DEFAULT_QUICK_APP_BLOCK))).toEqual(["EXE name is required."]);
  });

  it("refuses protected executables with their name", () => {
    expect(messages(schema.safeParse({ ...DEFAULT_QUICK_APP_BLOCK, exe_pattern: "explorer.exe" }))).toEqual([
      "'explorer.exe' is protected and can't be blocked.",
    ]);
  });

  it("needs a usable window when the schedule is on", () => {
    const form = { ...DEFAULT_QUICK_APP_BLOCK, exe_pattern: "tiktok.exe", scheduled: true, schedule_rows: [{ day_of_week: 1, start: "10:00", end: "10:00" }] };
    expect(messages(schema.safeParse(form))).toEqual(["Add a valid window (end after start)."]);
    expect(schema.safeParse({ ...form, schedule_rows: [{ day_of_week: 1, start: "22:00", end: "06:00" }] }).success).toBe(true);
  });

  it("accepts a plain exe", () => {
    expect(schema.safeParse({ ...DEFAULT_QUICK_APP_BLOCK, exe_pattern: "tiktok.exe" }).success).toBe(true);
  });
});

describe("quickAppBlockToBody", () => {
  it("scopes to the device and labels the rule with the exe when no label is typed", () => {
    expect(quickAppBlockToBody({ ...DEFAULT_QUICK_APP_BLOCK, exe_pattern: " tiktok.exe " }, "a1")).toEqual({
      name: "tiktok.exe", exe_pattern: "tiktok.exe", match_mode: "contains", scopes: [{ kind: "agent", agent_id: "a1" }], schedules: undefined,
    });
  });

  it("applies to all devices with a label and expanded schedule", () => {
    const body = quickAppBlockToBody({
      ...DEFAULT_QUICK_APP_BLOCK, exe_pattern: "a.exe", label: " Games ", apply_to_all: true, scheduled: true,
      schedule_rows: [{ day_of_week: 6, start: "23:00", end: "01:00" }],
    }, "a1");
    expect(body.name).toBe("Games");
    expect(body.scopes).toEqual([{ kind: "all" }]);
    expect(body.schedules).toEqual([
      { day_of_week: 6, start_minute: 1380, end_minute: 1440 },
      { day_of_week: 0, start_minute: 0, end_minute: 60 },
    ]);
  });
});
