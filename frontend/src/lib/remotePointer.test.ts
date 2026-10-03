import { describe, expect, it } from "vitest";
import { remoteImagePoint } from "./remotePointer";

describe("remote image pointer coordinates", () => {
  it("rejects letterbox and pillarbox clicks without sending edge clicks", () => {
    expect(remoteImagePoint({ left: 10, top: 20, width: 400, height: 400 }, 1920, 1080, 210, 30)).toBeNull();
    expect(remoteImagePoint({ left: 0, top: 0, width: 600, height: 400 }, 1080, 1920, 10, 200)).toBeNull();
    expect(remoteImagePoint({ left: 10, top: 20, width: 400, height: 400 }, 1920, 1080, 210, 220)).toEqual({ x: 960, y: 540 });
  });
  it("keeps bottom/right edges within the encoded pixel range and clamps drags", () => {
    const bounds = { left: 0, top: 0, width: 960, height: 540 };
    expect(remoteImagePoint(bounds, 1920, 1080, 960, 540)).toEqual({ x: 1919, y: 1079 });
    expect(remoteImagePoint(bounds, 1920, 1080, -30, 600, true)).toEqual({ x: 0, y: 1079 });
    expect(remoteImagePoint(bounds, 1920, 1080, -30, 600)).toBeNull();
  });
  it("uses the latest image bounds after resize and rejects unloaded images", () => {
    expect(remoteImagePoint({ left: 50, top: 100, width: 200, height: 100 }, 1000, 500, 100, 125)).toEqual({ x: 250, y: 125 });
    expect(remoteImagePoint({ left: 0, top: 0, width: 200, height: 100 }, 0, 0, 10, 10)).toBeNull();
    expect(remoteImagePoint({ left: 0, top: 0, width: 200, height: 100 }, 1000, 500, NaN, 10)).toBeNull();
  });
});
