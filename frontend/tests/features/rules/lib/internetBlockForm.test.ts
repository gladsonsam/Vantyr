import { describe, expect, it } from "vitest";
import { defaultInternetBlockForm, internetBlockFormToBody, internetBlockSchema, internetScheduleSchema, internetScheduleWindows, SCHEDULE_NEEDS_WINDOW } from "@/features/rules/lib/internetBlockForm";

describe("internetBlockSchema", () => {
  it("accepts an unscheduled rule even with a nonsense window", () => {
    const form = { ...defaultInternetBlockForm(), schedule_rows: [{ day_of_week: 1, start: "x", end: "y" }] };
    expect(internetBlockSchema.safeParse(form).success).toBe(true);
  });

  it("rejects an enabled schedule with no usable window, on the schedule rows", () => {
    const form = { ...defaultInternetBlockForm(), scheduled: true, schedule_rows: [{ day_of_week: 1, start: "10:00", end: "10:00" }] };
    const result = internetBlockSchema.safeParse(form);
    expect(result.error?.issues).toMatchObject([{ path: ["schedule_rows"], message: SCHEDULE_NEEDS_WINDOW }]);
  });

  it("accepts an enabled schedule with one valid window", () => {
    expect(internetBlockSchema.safeParse({ ...defaultInternetBlockForm(), scheduled: true }).success).toBe(true);
  });
});

describe("internetBlockFormToBody", () => {
  it("trims the name and leaves schedules out when the schedule is off", () => {
    const body = internetBlockFormToBody({ ...defaultInternetBlockForm(), name: "  School " });
    expect(body.name).toBe("School");
    expect(body.schedules).toBeUndefined();
  });

  it("sends empty scope ids as undefined", () => {
    const body = internetBlockFormToBody({
      ...defaultInternetBlockForm(),
      scopes: [{ kind: "group", group_id: "g1", agent_id: "" }, { kind: "all", group_id: "", agent_id: "" }],
    });
    expect(body.scopes).toEqual([
      { kind: "group", group_id: "g1", agent_id: undefined },
      { kind: "all", group_id: undefined, agent_id: undefined },
    ]);
  });

  it("expands the schedule rows when the schedule is on", () => {
    const body = internetBlockFormToBody({
      ...defaultInternetBlockForm(),
      scheduled: true,
      schedule_rows: [{ day_of_week: 0, start: "21:00", end: "07:00" }],
    });
    expect(body.schedules).toEqual([
      { day_of_week: 0, start_minute: 1260, end_minute: 1440 },
      { day_of_week: 1, start_minute: 0, end_minute: 420 },
    ]);
  });
});

describe("internetBlockSchema scope and window checks", () => {
  it("names a scope row that picks nothing", () => {
    const form = { ...defaultInternetBlockForm(), scopes: [{ kind: "agent" as const, group_id: "", agent_id: "" }] };
    expect(internetBlockSchema.safeParse(form).error?.issues).toMatchObject([{ path: ["scopes"], message: "Each agent scope must select an agent" }]);
  });

  it("names the window that would be dropped instead of saving the others silently", () => {
    const form = {
      ...defaultInternetBlockForm(),
      scheduled: true,
      schedule_rows: [{ day_of_week: 1, start: "09:00", end: "17:00" }, { day_of_week: 2, start: "x", end: "17:00" }],
    };
    expect(internetBlockSchema.safeParse(form).error?.issues).toMatchObject([{ path: ["schedule_rows"], message: "Window 2 needs two different times in HH:MM." }]);
  });
});

describe("internetScheduleSchema", () => {
  const rows = [{ day_of_week: 1, start: "18:00", end: "22:00" }];

  it("stores no windows (blocks all the time) when set hours are off, whatever rows are left", () => {
    const form = { scheduled: false, schedule_rows: [{ day_of_week: 1, start: "x", end: "y" }] };
    expect(internetScheduleSchema.safeParse(form).success).toBe(true);
    expect(internetScheduleWindows(form)).toEqual([]);
  });

  it("stores the windows when set hours are on, and rejects unusable ones", () => {
    expect(internetScheduleWindows({ scheduled: true, schedule_rows: rows })).toEqual([{ day_of_week: 1, start_minute: 1080, end_minute: 1320 }]);
    expect(internetScheduleSchema.safeParse({ scheduled: true, schedule_rows: [{ day_of_week: 1, start: "x", end: "y" }] }).error?.issues).toMatchObject([
      { path: ["schedule_rows"], message: SCHEDULE_NEEDS_WINDOW },
    ]);
  });
});
