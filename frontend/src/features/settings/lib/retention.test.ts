import { describe, expect, it } from "vitest";
import { NO_RETENTION, parseRetentionDays, retentionSchema, retentionToBody, toRetentionValues } from "./retention";

describe("parseRetentionDays", () => {
  it("clamps to 0..36500 and treats junk as 0", () => {
    expect(parseRetentionDays("30")).toBe(30);
    expect(parseRetentionDays("-4")).toBe(0);
    expect(parseRetentionDays("99999")).toBe(36500);
    expect(parseRetentionDays("")).toBe(0);
    expect(parseRetentionDays("abc")).toBe(0);
  });
});

describe("retention mapping", () => {
  it("shows unlimited (null or missing) retention as 0", () => {
    expect(toRetentionValues({ keylog_days: null, url_days: 14 })).toEqual({ keylog_days: 0, window_days: 0, url_days: 14 });
  });

  it("sends 0 days as null", () => {
    expect(retentionToBody({ keylog_days: 0, window_days: 7, url_days: 0 })).toEqual({ keylog_days: null, window_days: 7, url_days: null });
  });
});

describe("retentionSchema", () => {
  it("accepts days in range and rejects the rest", () => {
    expect(retentionSchema.safeParse(NO_RETENTION).success).toBe(true);
    expect(retentionSchema.safeParse({ ...NO_RETENTION, url_days: 36500 }).success).toBe(true);
    expect(retentionSchema.safeParse({ ...NO_RETENTION, url_days: 36501 }).success).toBe(false);
    expect(retentionSchema.safeParse({ ...NO_RETENTION, url_days: -1 }).success).toBe(false);
  });
});
