import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_VALUES, enrollmentTokenSchema, parseTokenUses, tokenValuesToBody } from "@/features/enrollment/lib/enrollmentTokenForm";

describe("parseTokenUses", () => {
  it("clamps to 1..100000 and treats junk as 1", () => {
    expect(parseTokenUses("5")).toBe(5);
    expect(parseTokenUses("0")).toBe(1);
    expect(parseTokenUses("-3")).toBe(1);
    expect(parseTokenUses("")).toBe(1);
    expect(parseTokenUses("999999")).toBe(100_000);
  });
});

describe("tokenValuesToBody", () => {
  it("sends just the use count by default", () => {
    expect(tokenValuesToBody(DEFAULT_TOKEN_VALUES)).toEqual({ uses: 1 });
  });

  it("adds a clamped expiry and a trimmed note when given", () => {
    expect(tokenValuesToBody({ uses: 3, expire_hours: " 72 ", note: " lab pc " })).toEqual({ uses: 3, expires_in_hours: 72, note: "lab pc" });
    expect(tokenValuesToBody({ uses: 1, expire_hours: "0", note: "" }).expires_in_hours).toBe(1);
    expect(tokenValuesToBody({ uses: 1, expire_hours: "abc", note: "" }).expires_in_hours).toBe(1);
    expect(tokenValuesToBody({ uses: 1, expire_hours: "99999", note: "" }).expires_in_hours).toBe(8760);
  });

  it("ignores a whitespace-only note", () => {
    expect(tokenValuesToBody({ uses: 1, expire_hours: "", note: "   " })).toEqual({ uses: 1 });
  });
});

describe("enrollmentTokenSchema", () => {
  it("accepts the defaults", () => {
    expect(enrollmentTokenSchema.safeParse(DEFAULT_TOKEN_VALUES).success).toBe(true);
  });
});
