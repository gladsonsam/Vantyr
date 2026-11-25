import { describe, expect, it } from "vitest";
import { describeRetentionField, retentionDefaultPlaceholder } from "@/features/agent-settings/retentionForm";
import {
  autoUpdateChoice,
  autoUpdateEffective,
  updateRequestOutcome,
  versionLabel,
  versionState,
} from "@/features/agent-settings/updatePolicy";
import { deviceCaptureState, sameRecallSettings } from "@/features/recall/lib/captureStatus";
import type { DeviceModuleStatus, RecallSettings } from "@/api/types";

describe("retention wording", () => {
  it("says what blank, 0 and a number mean next to the inherited default", () => {
    expect(describeRetentionField("", 30)).toBe("Uses the default: keeps 30 days.");
    expect(describeRetentionField("0", 30)).toBe("Keeps forever, instead of the default (30 days).");
    expect(describeRetentionField("7", 30)).toBe("Keeps 7 days; the default is 30 days.");
    expect(describeRetentionField("1", null)).toBe("Keeps 1 day; the default is forever.");
    expect(describeRetentionField("", null)).toBe("Uses the default: keeps forever.");
  });
  it("stays silent for text that is not a valid value", () => {
    expect(describeRetentionField("abc", 30)).toBe("");
    expect(describeRetentionField("36501", 30)).toBe("");
    expect(describeRetentionField("-1", 30)).toBe("");
  });
  it("names the default in the placeholder", () => {
    expect(retentionDefaultPlaceholder(30)).toBe("Default: 30 days");
    expect(retentionDefaultPlaceholder(0)).toBe("Default: forever");
    expect(retentionDefaultPlaceholder(undefined)).toBe("Default: forever");
  });
});

describe("agent version and update requests", () => {
  it("never calls an unknown version up to date", () => {
    expect(versionState(null, "0.2.9")).toBe("installed-unknown");
    expect(versionState("0.2.9", null)).toBe("latest-unknown");
    expect(versionState("v0.1.6", "0.2.9")).toBe("available");
    expect(versionState("0.2.9", "v0.2.9")).toBe("current");
    expect(versionState("0.3.0", "0.2.9")).toBe("current");
    expect(versionLabel("0.1.6")).toBe("v0.1.6");
    expect(versionLabel(null)).toBe("Unknown");
  });
  it("only treats a different reported version as the result of a request", () => {
    const request = { at: 1000, from: "0.1.6" };
    expect(updateRequestOutcome(null, "0.1.6")).toBeNull();
    expect(updateRequestOutcome(request, "0.1.6")).toEqual({ kind: "waiting", at: 1000 });
    expect(updateRequestOutcome(request, "v0.1.6")).toEqual({ kind: "waiting", at: 1000 });
    expect(updateRequestOutcome(request, null)).toEqual({ kind: "waiting", at: 1000 });
    expect(updateRequestOutcome(request, "0.2.9")).toEqual({ kind: "changed", from: "0.1.6", to: "0.2.9" });
  });
  it("states the effective automatic-update setting and where it comes from", () => {
    expect(autoUpdateChoice(null)).toBe("inherit");
    expect(autoUpdateChoice({ enabled: true })).toBe("on");
    expect(autoUpdateChoice({ enabled: false })).toBe("off");
    expect(autoUpdateEffective(true, null)).toBe("On: following the server default.");
    expect(autoUpdateEffective(null, null)).toBe("Following the server default.");
    expect(autoUpdateEffective(true, { enabled: false })).toBe("Off: set for this device; the server default is On.");
  });
});

const grant = (enabled: boolean, available = true) => ({ module: "recall", enabled, available, revision: 1, authorization_required: !enabled });
const report = (over: Partial<DeviceModuleStatus> & { recall?: ReturnType<typeof grant> | null } = {}): DeviceModuleStatus => ({
  online: true,
  reported_at: "2026-10-03T00:00:00Z",
  authorization_current: true,
  pending: [],
  state: { type: "module_states", schema_version: 1, revision: 1, modules: over.recall === null ? [] : [over.recall ?? grant(true)] },
  ...over,
}) as DeviceModuleStatus;

describe("capture status separates saved settings from the device's permission", () => {
  it("says nothing is recorded when settings are off, whatever the device allows", () => {
    expect(deviceCaptureState(false, report(), true).text).toContain("off in these settings");
  });
  it("does not treat saved settings as permission", () => {
    expect(deviceCaptureState(true, report({ recall: grant(false) }), true)).toMatchObject({ tone: "warning" });
    expect(deviceCaptureState(true, report({ recall: grant(false) }), true).text).toContain("Only someone at the device");
    expect(deviceCaptureState(true, report({ recall: grant(true, false) }), true).text).toContain("cannot run Recall");
    expect(deviceCaptureState(true, report({ recall: null }), true).tone).toBe("warning");
    expect(deviceCaptureState(true, null, true).text).toContain("not reported");
  });
  it("qualifies a permission from an offline device or an earlier connection", () => {
    expect(deviceCaptureState(true, report(), true)).toEqual({ tone: "success", text: "The device allows Recall." });
    expect(deviceCaptureState(true, report({ online: false }), true).text).toContain("last report");
    expect(deviceCaptureState(true, report({ authorization_current: false }), true).text).toContain("earlier report");
  });
  it("tells viewers the device state is not shown to them", () => {
    expect(deviceCaptureState(true, null, false).text).toContain("operators");
  });
  it("compares every capture setting", () => {
    const a: RecallSettings = { enabled: true, interval_ms: 20000, hot_interval_ms: 6000, jpeg_quality: 45, max_dim: 1600, dedup_hamming: 4, keyframe_max_gap_ms: 300000, ocr: true };
    expect(sameRecallSettings(a, { ...a })).toBe(true);
    for (const key of Object.keys(a) as (keyof RecallSettings)[]) {
      expect(sameRecallSettings(a, { ...a, [key]: typeof a[key] === "boolean" ? !a[key] : (a[key] as number) + 1 })).toBe(false);
    }
  });
});
