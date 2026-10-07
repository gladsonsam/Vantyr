import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_PRESET_STORAGE_KEY, loadStreamPreset, monitorLabel, saveStreamPreset } from "./streamPresets";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("stream preset storage", () => {
  it("defaults to balanced and round-trips a saved preset", () => {
    expect(loadStreamPreset()).toBe("balanced");
    saveStreamPreset("sharp");
    expect(localStorage.getItem(STREAM_PRESET_STORAGE_KEY)).toBe("sharp");
    expect(loadStreamPreset()).toBe("sharp");
  });

  it("ignores unknown stored values and storage failures", () => {
    localStorage.setItem(STREAM_PRESET_STORAGE_KEY, "4k");
    expect(loadStreamPreset()).toBe("balanced");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadStreamPreset()).toBe("balanced");
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
