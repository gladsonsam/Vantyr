import { describe, expect, it } from "vitest";
import { hasValue, storedUptimeNote, storedWindowTooltip } from "@/features/fleet/lib/fleetUtils";

describe("fleetUtils placeholders and stored notes", () => {
  it("treats dash sentinels and blanks as missing", () => {
    expect(hasValue("-")).toBe(false);
    expect(hasValue("—")).toBe(false);
    expect(hasValue("  ")).toBe(false);
    expect(hasValue(null)).toBe(false);
    expect(hasValue("alice")).toBe(true);
  });

  it("describes stored snapshots in plain language without raw timestamps", () => {
    const at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const note = storedUptimeNote(at);
    expect(note?.hint).toBe("as of 3h ago");
    expect(note?.tooltip).not.toContain(at);
    expect(storedWindowTooltip(at)).toContain("3h ago");
    expect(storedUptimeNote(null)).toBeUndefined();
    expect(storedWindowTooltip("garbage")).toBeUndefined();
  });
});
