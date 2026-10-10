import { describe, expect, it } from "vitest";
import { emptyScheduleRow, expandScheduleRows, scheduleToRows } from "@/features/rules/lib/scheduleRows";
import { updateScopeRow } from "@/features/rules/lib/scopeRows";

describe("expandScheduleRows", () => {
  it("keeps a same-day window as one entry", () => {
    expect(expandScheduleRows([{ day_of_week: 2, start: "09:00", end: "17:30" }])).toEqual([
      { day_of_week: 2, start_minute: 540, end_minute: 1050 },
    ]);
  });

  it("splits an overnight window across the next day, wrapping Saturday to Sunday", () => {
    expect(expandScheduleRows([{ day_of_week: 6, start: "22:00", end: "06:00" }])).toEqual([
      { day_of_week: 6, start_minute: 1320, end_minute: 1440 },
      { day_of_week: 0, start_minute: 0, end_minute: 360 },
    ]);
  });

  it("drops rows with a bad time or an empty window", () => {
    expect(expandScheduleRows([
      { day_of_week: 1, start: "nope", end: "10:00" },
      { day_of_week: 1, start: "10:00", end: "10:00" },
      { day_of_week: 1, start: "08:00", end: "09:00" },
    ])).toEqual([{ day_of_week: 1, start_minute: 480, end_minute: 540 }]);
  });

  it("accepts 24:00 as the end of day", () => {
    expect(expandScheduleRows([{ day_of_week: 3, start: "20:00", end: "24:00" }])).toEqual([
      { day_of_week: 3, start_minute: 1200, end_minute: 1440 },
    ]);
  });
});

describe("scheduleToRows", () => {
  it("falls back to one default row when there are no windows", () => {
    expect(scheduleToRows([])).toEqual([emptyScheduleRow()]);
    expect(scheduleToRows(undefined)).toEqual([emptyScheduleRow()]);
  });

  it("formats stored minutes as HH:MM", () => {
    expect(scheduleToRows([{ day_of_week: 4, start_minute: 65, end_minute: 1440 }])).toEqual([
      { day_of_week: 4, start: "01:05", end: "24:00" },
    ]);
  });
});

describe("updateScopeRow", () => {
  const rows = [{ kind: "group" as const, group_id: "g1", agent_id: "" }];

  it("clears the ids that stop applying when the kind changes", () => {
    expect(updateScopeRow(rows, 0, { kind: "all" })).toEqual([{ kind: "all", group_id: "", agent_id: "" }]);
    expect(updateScopeRow(rows, 0, { kind: "agent" })).toEqual([{ kind: "agent", group_id: "", agent_id: "" }]);
  });

  it("leaves other rows and the original array untouched", () => {
    const two = [...rows, { kind: "all" as const, group_id: "", agent_id: "" }];
    const next = updateScopeRow(two, 0, { group_id: "g2" });
    expect(next[0].group_id).toBe("g2");
    expect(next[1]).toBe(two[1]);
    expect(two[0].group_id).toBe("g1");
  });
});
