import { describe, it, expect } from "vitest";
import { mergeLiveStatus } from "./live-status";

describe("mergeLiveStatus", () => {
  it("returns the patch when there is no prior snapshot", () => {
    expect(mergeLiveStatus(undefined, { window: "Code" })).toEqual({ window: "Code" });
  });

  it("merges a patch onto the previous snapshot without dropping other fields", () => {
    const prev = { window: "Code", app: "code.exe", url: "https://a" };
    expect(mergeLiveStatus(prev, { url: "https://b" })).toEqual({
      window: "Code",
      app: "code.exe",
      url: "https://b",
    });
  });

  it("does not mutate the previous snapshot", () => {
    const prev = { window: "Code" };
    const next = mergeLiveStatus(prev, { activity: "afk", idleSecs: 5 });
    expect(prev).toEqual({ window: "Code" });
    expect(next).toEqual({ window: "Code", activity: "afk", idleSecs: 5 });
  });

  it("applies the latest patch field over an earlier one (last-write-wins per field)", () => {
    const afterAfk = mergeLiveStatus({ activity: "active" }, { activity: "afk", idleSecs: 10 });
    const afterActive = mergeLiveStatus(afterAfk, { activity: "active", idleSecs: 0, idleSinceMs: undefined });
    expect(afterActive.activity).toBe("active");
    expect(afterActive.idleSecs).toBe(0);
  });
});
