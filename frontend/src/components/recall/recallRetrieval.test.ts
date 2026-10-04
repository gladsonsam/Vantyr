import { describe, expect, it } from "vitest";
import { deviceTime, preferenceKey, readItems, writeItems } from "./recallRetrieval";

describe("device wall clock", () => {
  it("uses the device zone rather than the viewer zone", () => {
    expect(deviceTime("2026-10-03T09:15", "Australia/Perth")).toBe(Date.parse("2026-10-03T01:15:00Z"));
    expect(deviceTime("2026-01-03T09:15", "America/New_York")).toBe(Date.parse("2026-01-03T14:15:00Z"));
  });
  it("rejects invalid dates, missing zones, DST gaps and repeated times", () => {
    expect(deviceTime("2026-02-30T09:15", "UTC")).toBeNull();
    expect(deviceTime("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(deviceTime("2026-11-01T01:30", "America/New_York")).toBeNull();
    expect(deviceTime("2026-10-03T09:15", null)).toBeNull();
    expect(deviceTime("invalid", "UTC")).toBeNull();
  });
});
it("isolates browser preferences by server, user and device and survives malformed storage", () => {
  localStorage.clear();
  const key = preferenceKey("u1", "a");
  expect(writeItems(key, [{ note: "private" }])).toBe(true);
  expect(readItems(key)).toEqual([{ note: "private" }]);
  expect(readItems(preferenceKey("u2", "a"))).toEqual([]);
  expect(readItems(preferenceKey("u1", "b"))).toEqual([]);
  localStorage.setItem("vantyr-server-settings", JSON.stringify({ serverOrigin: "https://other.example" }));
  expect(readItems(preferenceKey("u1", "a"))).toEqual([]);
  localStorage.removeItem("vantyr-server-settings");
  localStorage.setItem(key, "broken"); expect(readItems(key)).toEqual([]);
});
