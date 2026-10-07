import { describe, expect, it } from "vitest";
import { defaultInternetBlockForm, internetBlockFormToBody } from "./internetBlockForm";

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
