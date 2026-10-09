import { describe, expect, it } from "vitest";
import { buttonName, createWheelAccumulator, isModifierKey, keyDownAction } from "@/features/remote/lib/remoteKeys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("keyDownAction", () => {
  it("holds modifiers", () => {
    expect(keyDownAction(key("Control"))).toEqual({ kind: "modifier", key: "control" });
    expect(keyDownAction(key("Shift"))).toEqual({ kind: "modifier", key: "shift" });
    expect(isModifierKey("Meta")).toBe(true);
    expect(isModifierKey("a")).toBe(false);
  });

  it("maps named keys, including space", () => {
    expect(keyDownAction(key("Enter"))).toEqual({ kind: "special", key: "enter" });
    expect(keyDownAction(key("ArrowLeft"))).toEqual({ kind: "special", key: "arrowleft" });
    expect(keyDownAction(key(" "))).toEqual({ kind: "special", key: "space" });
    expect(keyDownAction(key("F12"))).toEqual({ kind: "special", key: "f12" });
  });

  it("types printable characters, or sends them as physical keys under a shortcut modifier", () => {
    expect(keyDownAction(key("a"))).toEqual({ kind: "text", text: "a" });
    expect(keyDownAction(key("é"))).toEqual({ kind: "text", text: "é" });
    expect(keyDownAction(key("v", { ctrlKey: true }))).toEqual({ kind: "char", char: "v" });
    expect(keyDownAction(key("x", { metaKey: true }))).toEqual({ kind: "char", char: "x" });
  });

  it("ignores keys it cannot map", () => {
    expect(keyDownAction(key("Unidentified"))).toBeNull();
    expect(keyDownAction(key("Dead"))).toBeNull();
  });
});

describe("buttonName", () => {
  it("maps pointer buttons", () => {
    expect(buttonName(0)).toBe("left");
    expect(buttonName(1)).toBe("middle");
    expect(buttonName(2)).toBe("right");
  });
});

describe("createWheelAccumulator", () => {
  it("converts pixel deltas to notches and carries fractions", () => {
    const wheel = createWheelAccumulator();
    expect(wheel({ deltaX: 0, deltaY: 40, deltaMode: 0 })).toBeNull();
    expect(wheel({ deltaX: 0, deltaY: 70, deltaMode: 0 })).toEqual({ dx: 0, dy: 1 });
    expect(wheel({ deltaX: 0, deltaY: 90, deltaMode: 0 })).toEqual({ dx: 0, dy: 1 });
  });

  it("treats line and page modes as whole notches and clamps to ten per event", () => {
    const wheel = createWheelAccumulator();
    expect(wheel({ deltaX: -3, deltaY: 2, deltaMode: 1 })).toEqual({ dx: -3, dy: 2 });
    expect(wheel({ deltaX: 0, deltaY: 3, deltaMode: 2 })).toEqual({ dx: 0, dy: 10 });
    // The 20 notches beyond the clamp carry over to the next event.
    expect(wheel({ deltaX: 0, deltaY: 0, deltaMode: 0 })).toEqual({ dx: 0, dy: 10 });
  });
});
