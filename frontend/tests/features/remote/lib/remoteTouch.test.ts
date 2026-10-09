import { expect, it } from "vitest";
import { clampPan, remoteTextChunks, touchPoint, trackpadPoint } from "@/features/remote/lib/remoteTouch";
it("maps direct touch through a zoomed, panned and letterboxed image", () => {
  const bounds = {left: -200, top: -200, width: 800, height: 800};
  expect(touchPoint("direct", bounds, 1280, 720, {x: 200, y: 200}, {x: 0, y: 0}, {x: 0, y: 0})).toEqual({x: 640, y: 360});
  expect(touchPoint("direct", bounds, 1280, 720, {x: 200, y: -150}, {x: 0, y: 0}, {x: 0, y: 0})).toBeNull();
});
it("scales relative motion at local zoom and clamps both cursor and pan", () => {
  expect(trackpadPoint({left: 0, top: 0, width: 800, height: 800}, 1280, 720, {x: 640, y: 360}, 40, 0)).toEqual({x: 704, y: 360});
  expect(trackpadPoint({left: 0, top: 0, width: 400, height: 400}, 1280, 720, {x: 640, y: 360}, 4000, -4000)).toEqual({x: 1279, y: 0});
  expect(clampPan({x: 200, y: -200}, 320, 180, 2)).toEqual({x: 160, y: -90});
  expect(clampPan({x: 200, y: -200}, 320, 180, 1)).toEqual({x: 0, y: 0});
});
it("preserves Unicode and bounds every text packet and the whole submission", () => {
  const text = "日😀".repeat(512);
  expect(remoteTextChunks(text).join("")).toBe(text); expect(remoteTextChunks(text).every(chunk => Array.from(chunk).length <= 512)).toBe(true);
  expect(() => remoteTextChunks("a".repeat(8001))).toThrow("8,000"); expect(remoteTextChunks("")).toEqual([]);
});
it("rejects zero-size geometry rather than manufacturing input coordinates", () => {
  expect(trackpadPoint({left: 0, top: 0, width: 0, height: 0}, 1280, 720, {x: 640, y: 360}, 20, 20)).toBeNull();
});
it("keeps local pan inside zoomed image pixels rather than exposing large letterbox gaps", () => {
  expect(clampPan({x: 400, y: 400}, 400, 400, 2, 1280, 720)).toEqual({x: 200, y: 25});
});
