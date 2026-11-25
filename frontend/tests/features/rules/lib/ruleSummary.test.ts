import { describe, expect, it } from "vitest";
import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";
import {
  appBlockScopeLabels,
  enabledCount,
  ruleScopeLabels,
  runCountsSummary,
  runStatus,
  scheduleLabels,
  scriptScheduleLabels,
} from "@/features/rules/lib/ruleSummary";

const groups = [{ id: "g1", name: "Lab" }] as AgentGroup[];
const agentsById = { a1: { id: "a1", name: "Alpha" } } as unknown as Record<string, Agent>;
const win = (day_of_week: number, start: string, end: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return { day_of_week, start_minute: m(start), end_minute: m(end) };
};

describe("scheduleLabels", () => {
  it("says Always when there are no windows", () => {
    expect(scheduleLabels([])).toEqual(["Always"]);
    expect(scheduleLabels(undefined)).toEqual(["Always"]);
  });

  it("collapses consecutive days that share hours, Monday first", () => {
    const week = [1, 2, 3, 4, 5].map((d) => win(d, "09:00", "17:00"));
    expect(scheduleLabels(week)).toEqual(["Mon–Fri 09:00–17:00"]);
    expect(scheduleLabels([win(0, "10:00", "12:00"), win(6, "10:00", "12:00")])).toEqual(["Sat, Sun 10:00–12:00"]);
  });

  it("keeps different hours apart and calls a whole day all day", () => {
    expect(scheduleLabels([win(1, "09:00", "17:00"), win(3, "00:00", "23:59"), win(2, "09:00", "17:00")])).toEqual([
      "Mon, Tue 09:00–17:00",
      "Wed all day",
    ]);
  });

  it("shows an overnight window as the one window it was entered as", () => {
    // Fri 22:00 → Sat 06:00 is stored as two windows; it reads as one.
    expect(scheduleLabels([win(5, "22:00", "24:00"), win(6, "00:00", "06:00")])).toEqual(["Fri 22:00 → Sat 06:00"]);
    // Saturday night runs into Sunday.
    expect(scheduleLabels([win(6, "22:00", "24:00"), win(0, "00:00", "06:00")])).toEqual(["Sat 22:00 → Sun 06:00"]);
  });

  it("does not merge back-to-back windows the editor would not have split", () => {
    expect(scheduleLabels([win(1, "08:00", "24:00"), win(2, "00:00", "09:00")])).toEqual(["Mon 08:00–24:00", "Tue 00:00–09:00"]);
  });
});

describe("scriptScheduleLabels", () => {
  it("reads each schedule as plain words", () => {
    expect(
      scriptScheduleLabels([
        { frequency: "hourly", fire_minute: 5 },
        { frequency: "daily", fire_minute: 180 },
        { frequency: "weekly", day_of_week: 1, fire_minute: 120 },
      ]),
    ).toEqual(["Every hour at :05", "Every day at 03:00", "Mondays at 02:00"]);
  });

  it("says a script without a schedule only runs on request", () => {
    expect(scriptScheduleLabels([])).toEqual(["Never (run now only)"]);
  });
});

describe("script run status", () => {
  it("never reports a script as run until the device has reported back", () => {
    expect(runStatus("fired")).toEqual({ label: "Sent, no result yet", tone: "wait" });
    expect(runStatus("skipped_offline")).toEqual({ label: "Skipped, device offline", tone: "muted" });
    expect(runStatus("success")).toEqual({ label: "Succeeded", tone: "ok" });
    expect(runStatus("failed").tone).toBe("bad");
    expect(runStatus("error")).toEqual({ label: "Couldn’t run", tone: "bad" });
    expect(runStatus("weird")).toEqual({ label: "weird", tone: "muted" });
  });

  it("summarises a fire across devices, worst first", () => {
    expect(runCountsSummary({ success: 3 })).toEqual({ text: "Succeeded on 3 devices", tone: "ok" });
    expect(runCountsSummary({ success: 4, failed: 1 })).toEqual({ text: "1 failed, 4 succeeded", tone: "bad" });
    expect(runCountsSummary({ fired: 2, skipped_offline: 1 })).toEqual({ text: "2 waiting for a result, 1 offline, skipped", tone: "wait" });
    expect(runCountsSummary({ success: 1 })).toEqual({ text: "Succeeded", tone: "ok" });
  });
});

describe("scope labels", () => {
  it("names groups and agents, and says unknown for ones that are gone", () => {
    expect(ruleScopeLabels([{ kind: "group", group_id: "g1" }, { kind: "agent", agent_id: "a1" }, { kind: "agent", agent_id: "zz" }], groups, agentsById)).toEqual([
      "Group · Lab",
      "Agent · Alpha",
      "Agent · unknown",
    ]);
    expect(ruleScopeLabels([{ kind: "all" }, { kind: "group", group_id: "g1" }], groups, agentsById)).toEqual(["All devices"]);
    expect(ruleScopeLabels([], groups, agentsById)).toEqual(["No scope"]);
  });

  it("falls back to the summarised scope of a rule loaded for one agent", () => {
    const legacy = (scope_kind: "all" | "group" | "agent") => ({ id: 1, name: "x", exe_pattern: "x", match_mode: "exact", enabled: true, schedules: [], scope_kind }) as unknown as AppBlockRule;
    expect(appBlockScopeLabels(legacy("agent"), groups, agentsById)).toEqual(["This device"]);
    expect(appBlockScopeLabels(legacy("all"), groups, agentsById)).toEqual(["All devices"]);
  });
});

describe("enabledCount", () => {
  it("counts what is on", () => {
    expect(enabledCount([{ enabled: true }], "rule")).toBe("1 rule · all on");
    expect(enabledCount([{ enabled: true }, { enabled: false }, { enabled: false }], "script")).toBe("3 scripts · 1 on");
  });
});
