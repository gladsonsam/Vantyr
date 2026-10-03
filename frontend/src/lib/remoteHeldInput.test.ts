import { expect, it } from "vitest";
import { RemoteHeldInput } from "./remoteHeldInput";
it("releases held modifiers and drags at the latest pointer position exactly once", () => {
  const input = new RemoteHeldInput();
  expect(input.keyDown("control")).toBe(true);
  expect(input.keyDown("control")).toBe(false);
  input.keyDown("shift"); input.buttonDown("left", { x: 10, y: 20 }); input.move({ x: 30, y: 40 });
  expect(input.releaseAll()).toEqual([{ type: "KeyUp", key: "control" }, { type: "KeyUp", key: "shift" }, { type: "MouseUp", button: "left", x: 30, y: 40 }]);
  expect(input.releaseAll()).toEqual([]);
});
it("normal key/button release and pointer capture loss do not duplicate releases", () => {
  const input = new RemoteHeldInput();
  input.keyDown("alt"); input.buttonDown("right", { x: 10, y: 20 });
  expect(input.releaseButtons()).toEqual([{ type: "MouseUp", button: "right", x: 10, y: 20 }]);
  expect(input.keyUp("alt")).toBe(true); expect(input.keyUp("alt")).toBe(false);
  input.buttonDown("left", { x: 20, y: 30 }); expect(input.buttonUp("left")).toBe(true);
  expect(input.releaseAll()).toEqual([]);
});
