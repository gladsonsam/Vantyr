import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DATE_PRESETS,
  absoluteRangeForPresetDays,
  presetKeyForValue,
  resolveDateRangeToDayBounds,
} from "@/features/activity/activityDateRange";

describe("resolveDateRangeToDayBounds", () => {
  it("returns null for no range", () => {
    expect(resolveDateRangeToDayBounds(null)).toBeNull();
  });

  it("normalises ISO dates (with or without a time part) to local day keys", () => {
    expect(
      resolveDateRangeToDayBounds({ type: "absolute", startDate: "2026-03-01T10:00:00Z", endDate: "2026-03-04" }),
    ).toEqual({ start: "2026-03-01", end: "2026-03-04" });
  });

  it("swaps reversed bounds", () => {
    expect(
      resolveDateRangeToDayBounds({ type: "absolute", startDate: "2026-03-09", endDate: "2026-03-02" }),
    ).toEqual({ start: "2026-03-02", end: "2026-03-09" });
  });

  it("rejects unparseable dates", () => {
    expect(resolveDateRangeToDayBounds({ type: "absolute", startDate: "nope", endDate: "2026-03-02" })).toBeNull();
    expect(resolveDateRangeToDayBounds({ type: "absolute", startDate: "2026-03", endDate: "2026-03-02" })).toBeNull();
  });
});

describe("date presets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10, 15, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes inclusive day ranges ending today", () => {
    expect(absoluteRangeForPresetDays(1)).toEqual({ start: "2026-03-10", end: "2026-03-10" });
    expect(absoluteRangeForPresetDays(7)).toEqual({ start: "2026-03-04", end: "2026-03-10" });
    expect(absoluteRangeForPresetDays(30)).toEqual({ start: "2026-02-09", end: "2026-03-10" });
  });

  it("maps each preset's range back to its key", () => {
    expect(presetKeyForValue(null)).toBe("all");
    for (const preset of DATE_PRESETS) {
      if (preset.days == null) continue;
      const { start, end } = absoluteRangeForPresetDays(preset.days);
      expect(presetKeyForValue({ type: "absolute", startDate: start, endDate: end })).toBe(preset.key);
    }
  });

  it("reports hand-picked or invalid ranges as custom", () => {
    expect(presetKeyForValue({ type: "absolute", startDate: "2026-03-01", endDate: "2026-03-03" })).toBe("custom");
    expect(presetKeyForValue({ type: "absolute", startDate: "bad", endDate: "bad" })).toBe("custom");
  });
});
