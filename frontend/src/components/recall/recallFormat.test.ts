import { describe, expect, it } from "vitest";
import { addCalendarDays, dayIn, dayRange } from "./recallFormat";
import { parseRecallParams, recallPageHref } from "../../lib/recallUrl";

describe("Recall calendar and shared state", () => {
  it("uses the device date across opposite UTC offsets", () => {
    const at = Date.parse("2026-10-03T01:00:00Z");
    expect(dayIn("America/Los_Angeles", at)).toBe("2026-10-02");
    expect(dayIn("Australia/Perth", at)).toBe("2026-10-03");
    expect(dayRange("2026-10-03", "Australia/Perth").fromMs).toBe(Date.parse("2026-10-02T16:00:00Z"));
  });
  it("uses calendar boundaries over both DST transitions", () => {
    const spring = dayRange("2026-03-08", "America/New_York");
    const autumn = dayRange("2026-11-01", "America/New_York");
    expect(spring.toMs - spring.fromMs).toBe(23 * 3600_000);
    expect(autumn.toMs - autumn.fromMs).toBe(25 * 3600_000);
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("round trips all shared state and rejects malformed state", () => {
    const state = { at: "2026-10-03T01:00:00Z", day: "2026-10-02", monitor: 0 };
    expect(parseRecallParams(new URL(recallPageHref("pc", state), "https://example.test").searchParams))
      .toEqual({ agent: "pc", ...state });
    expect(parseRecallParams(new URLSearchParams("at=no&day=2026-02-30&monitor=-1")))
      .toEqual({ agent: null, at: null, day: null, monitor: null });
  });
});
