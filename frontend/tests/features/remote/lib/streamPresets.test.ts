import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import {
  STREAM_PRESET_STORAGE_KEY,
  STREAM_PRESET_TUNING,
  loadStreamPreset,
  monitorLabel,
  saveStreamPreset,
} from "@/features/remote/lib/streamPresets";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("stream preset storage", () => {
  it("defaults to Auto and round-trips a saved preset", () => {
    expect(loadStreamPreset()).toBe("auto");
    saveStreamPreset("sharp");
    expect(localStorage.getItem(STREAM_PRESET_STORAGE_KEY)).toBe("sharp");
    expect(loadStreamPreset()).toBe("sharp");
  });

  it("ignores unknown stored values and storage failures", () => {
    localStorage.setItem(STREAM_PRESET_STORAGE_KEY, "4k");
    expect(loadStreamPreset()).toBe("auto");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadStreamPreset()).toBe("auto");
    expect(() => saveStreamPreset("ultra")).not.toThrow();
  });
});

describe("monitorLabel", () => {
  it("names, sizes and marks the primary display", () => {
    expect(monitorLabel({ name: "DELL U2720Q", width: 3840, height: 2160, primary: true }, 0)).toBe(
      "DELL U2720Q (3840×2160) • Primary",
    );
    expect(monitorLabel({ name: "  ", primary: false }, 1)).toBe("Display 2");
  });
});

it("keeps desktop presets legible within the deployed server quality range", () => {
  expect(STREAM_PRESET_TUNING.balanced.jpegQ).toBeGreaterThanOrEqual(75);
  const ordered = ["saver", "balanced", "sharp", "ultra"] as const;
  for (let i = 0; i < ordered.length; i++) {
    const tuning = STREAM_PRESET_TUNING[ordered[i]];
    expect(tuning.jpegQ).toBeLessThanOrEqual(85);
    expect(tuning.intervalMs).toBeGreaterThanOrEqual(33);
    if (i) expect(tuning.jpegQ).toBeGreaterThan(STREAM_PRESET_TUNING[ordered[i - 1]].jpegQ);
  }
});

it("preserves every explicit manual choice", () => {
  for (const preset of ["saver", "balanced", "sharp", "ultra"] as const) {
    saveStreamPreset(preset);
    expect(loadStreamPreset()).toBe(preset);
  }
});
