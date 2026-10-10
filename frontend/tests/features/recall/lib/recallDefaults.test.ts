import { describe, expect, it } from "vitest";
import { describeEmptyRange, latestRecordedDay, pickDefaultAgentId } from "@/features/recall/lib/recallDefaults";

const day = (d: string, frame_count = 5) => ({ day: d, frame_count, first_ts: null, last_ts: null }) as never;

describe("pickDefaultAgentId", () => {
  it("prefers online, then most recently seen", () => {
    const agents = [
      { id: "a", online: false, last_seen: "2026-10-09T00:00:00Z" },
      { id: "b", online: false, last_seen: "2026-10-10T00:00:00Z" },
      { id: "c", online: true, last_seen: "2026-10-01T00:00:00Z" },
    ];
    expect(pickDefaultAgentId(agents)).toBe("c");
    expect(pickDefaultAgentId(agents.slice(0, 2))).toBe("b");
    expect(pickDefaultAgentId([])).toBeNull();
  });
});

describe("latestRecordedDay", () => {
  it("ignores empty and future days", () => {
    const days = [day("2026-10-01"), day("2026-10-05", 0), day("2026-10-20")];
    expect(latestRecordedDay(days, "2026-10-10")?.day).toBe("2026-10-01");
    expect(latestRecordedDay([], "2026-10-10")).toBeNull();
  });
});

describe("describeEmptyRange", () => {
  const days = [day("2026-10-01"), day("2026-10-03")];
  const base = { online: true, days, today: "2026-10-10" };
  it("covers distinct cases without saying the reason is unknown", () => {
    const msgs = [
      describeEmptyRange({ ...base, days: [], day: "2026-10-10", online: false }),
      describeEmptyRange({ ...base, day: "2026-09-01" }),
      describeEmptyRange({ ...base, day: "2026-10-10", online: false }),
      describeEmptyRange({ ...base, day: "2026-10-02" }),
      describeEmptyRange({ ...base, day: "2026-10-03" }),
      describeEmptyRange({ ...base, days: null, day: "2026-10-10", online: null }),
    ];
    expect(new Set(msgs).size).toBe(msgs.length);
    expect(msgs.join(" ")).not.toMatch(/unknown/);
    expect(msgs[0]).toContain("offline");
    expect(msgs[1]).toContain("expired");
    expect(msgs[2]).toContain("since 2026-10-03");
  });
});
