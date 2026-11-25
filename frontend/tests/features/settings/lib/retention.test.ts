import { describe, expect, it } from "vitest";
import {
  describeRetention,
  parseRetentionFields,
  parseRetentionText,
  retentionBody,
  shortensRetention,
  toRetentionFields,
} from "@/features/settings/lib/retention";

describe("parseRetentionText", () => {
  it("keeps forever for blank or 0, and accepts whole days from 1 to 36500", () => {
    expect(parseRetentionText("")).toEqual({ days: null, error: null });
    expect(parseRetentionText("  ")).toEqual({ days: null, error: null });
    expect(parseRetentionText("0")).toEqual({ days: null, error: null });
    expect(parseRetentionText("30")).toEqual({ days: 30, error: null });
    expect(parseRetentionText("36500")).toEqual({ days: 36500, error: null });
  });

  it("reports what it cannot use instead of clamping it", () => {
    for (const text of ["-4", "36501", "99999", "abc", "1.5", "1e3"]) {
      const parsed = parseRetentionText(text);
      expect(parsed.days).toBeNull();
      expect(parsed.error).not.toBeNull();
    }
  });
});

describe("retention mapping", () => {
  it("shows unlimited (null or missing) retention as 0", () => {
    expect(toRetentionFields({ keylog_days: null, url_days: 14 })).toEqual({ keylog_days: "0", window_days: "0", url_days: "14" });
  });

  it("sends 0 and blank as null", () => {
    const parsed = parseRetentionFields({ keylog_days: "0", window_days: "7", url_days: "" });
    expect(retentionBody(parsed)).toEqual({ keylog_days: null, window_days: 7, url_days: null });
  });
});

describe("describeRetention", () => {
  it("says what will be deleted and what is saved while they differ", () => {
    expect(describeRetention(parseRetentionText("14"), 14)).toBe("Deletes data older than 14 days.");
    expect(describeRetention(parseRetentionText("1"), null)).toBe("Deletes data older than 1 day. Saved: forever.");
    expect(describeRetention(parseRetentionText("0"), 30)).toBe("Keeps this data forever. Saved: 30 days.");
    expect(describeRetention(parseRetentionText(""), null)).toBe("Keeps this data forever.");
    expect(describeRetention(parseRetentionText("abc"), 30)).toBe("");
  });
});

describe("shortensRetention", () => {
  it("is true only when data would be kept for less time than now", () => {
    expect(shortensRetention(null, 30)).toBe(true);
    expect(shortensRetention(undefined, 30)).toBe(true);
    expect(shortensRetention(30, 7)).toBe(true);
    expect(shortensRetention(30, 30)).toBe(false);
    expect(shortensRetention(30, 90)).toBe(false);
    expect(shortensRetention(30, null)).toBe(false);
    expect(shortensRetention(null, null)).toBe(false);
  });
});
