import { describe, expect, it } from "vitest";
import { hasValue, isNewerVersion, lastReportedTooltip } from "@/features/fleet/lib/fleetUtils";

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
    expect(lastReportedTooltip(at)).toBe("Last reported 3h ago");
    expect(lastReportedTooltip(null)).toBeUndefined();
    expect(lastReportedTooltip("garbage")).toBeUndefined();
  });

  it("only offers an update when the latest version is newer", () => {
    expect(isNewerVersion("0.1.4", "v0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.4", "0.1.6")).toBe(false);
    expect(isNewerVersion("v0.1.4", "0.1.4")).toBe(false);
    expect(isNewerVersion("0.2", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion(null, "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.4", "dev")).toBe(false);
  });
});
