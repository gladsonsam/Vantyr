import { describe, expect, it } from "vitest";
import { fmtDayLabel } from "@/lib/utils";

describe("fmtDayLabel", () => {
  const now = new Date(2026, 9, 28, 18, 0);

  it("names today and yesterday", () => {
    expect(fmtDayLabel(new Date(2026, 9, 28, 0, 5), now)).toBe("Today");
    expect(fmtDayLabel(new Date(2026, 9, 27, 23, 59), now)).toBe("Yesterday");
  });

  it("drops the year only for this year", () => {
    expect(fmtDayLabel(new Date(2026, 9, 20), now)).not.toContain("2026");
    expect(fmtDayLabel(new Date(2025, 9, 20), now)).toContain("2025");
  });
});
