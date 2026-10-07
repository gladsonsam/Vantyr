import { describe, expect, it, vi } from "vitest";
import { loadFramePages } from "./recallPaging";
import type { ScreenFrame, ScreenFramesResponse } from "@/api/types";
const frame = (id: number): ScreenFrame => ({ id, captured_at: "2026-10-03T12:00:00Z", monitor: 0, w: 1920, h: 1080, phash: "0", has_ocr: true });
const page = (ids: number[], next: string | null): ScreenFramesResponse => ({ from: "2026-10-03T00:00:00Z", to: "2026-10-04T00:00:00Z", count: ids.length, frames: ids.map(frame), next_cursor: next, complete: !next, has_more: !!next });

describe("Recall frame pagination", () => {
  it("loads beyond 3000 frames, deduplicates overlap and preserves tied timestamps", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page(Array.from({ length: 3000 }, (_, i) => i + 1), "next"))
      .mockResolvedValueOnce(page([3000, 3001, 3002], null));
    const progress = vi.fn();
    await loadFramePages(fetch, progress, () => true);
    expect(fetch.mock.calls).toEqual([[undefined], ["next"]]);
    expect(progress.mock.calls[0][0].complete).toBe(false);
    expect(progress.mock.calls[1][0].frames).toHaveLength(3002);
    expect(progress.mock.calls[1][0].frames.at(-1).id).toBe(3002);
    expect(progress.mock.calls[1][0].complete).toBe(true);
  });
  it("discards an in-flight page after changing device or range", async () => {
    let current = true;
    const progress = vi.fn();
    await loadFramePages(async () => { current = false; return page([1], "next"); }, progress, () => current);
    expect(progress).not.toHaveBeenCalled();
  });
  it("rejects a repeating cursor instead of looping forever", async () => {
    await expect(loadFramePages(async () => page([1], "same"), vi.fn(), () => true)).rejects.toThrow("did not advance");
  });
  it("does not claim complete history from a legacy response", async () => {
    const progress = vi.fn();
    await loadFramePages(async () => ({ from: "", to: "", count: 1, frames: [frame(1)] }), progress, () => true);
    expect(progress.mock.calls[0][0].complete).toBeNull();
  });
});
