import { describe, expect, it } from "vitest";
import { advancePlayhead, frameIndexAt } from "./recallPlayback";

/** 10:00:00 UTC, as a readable base for frame times. */
const T0 = Date.UTC(2026, 8, 7, 10, 0, 0);
const sec = (n: number) => T0 + n * 1000;

describe("frameIndexAt", () => {
  const times = [sec(0), sec(10), sec(20), sec(30)];

  it("returns the frame at or before the instant", () => {
    expect(frameIndexAt(times, sec(0))).toBe(0);
    expect(frameIndexAt(times, sec(15))).toBe(1);
    expect(frameIndexAt(times, sec(20))).toBe(2);
    expect(frameIndexAt(times, sec(999))).toBe(3);
  });

  it("clamps to the first frame rather than reporting nothing", () => {
    // Scrubbing before the first keyframe should show that keyframe, not a blank
    // stage — the window's start is arbitrary, the first frame is real.
    expect(frameIndexAt(times, sec(-500))).toBe(0);
  });

  it("reports -1 only when there are no frames", () => {
    expect(frameIndexAt([], sec(0))).toBe(-1);
  });
});

describe("advancePlayhead", () => {
  const base = { perTickMs: 6_000, holdMs: 30_000, toMs: sec(3_600) };

  it("advances in real time through dense coverage", () => {
    // Frames every 10s, ticking 6s of history: the playhead moves smoothly and does
    // not snap, because it never sits past a frame longer than the hold.
    const times = [sec(0), sec(10), sec(20), sec(30)];
    const r = advancePlayhead({ ...base, times, playheadMs: sec(4) });
    expect(r).toEqual({ playheadMs: sec(10), ended: false });
  });

  it("skips an idle gap instead of playing it out in real time", () => {
    // Two frames either side of an eight-hour overnight gap. Real-time advance would
    // need ~80 minutes of wall-clock at this rate to cross it; jump to the next frame.
    const times = [sec(0), sec(8 * 3600)];
    const r = advancePlayhead({
      ...base,
      times,
      playheadMs: sec(0),
      toMs: sec(9 * 3600),
    });
    // First tick still lands inside the hold window and advances normally...
    expect(r.playheadMs).toBe(sec(6));
    // ...but once past the hold, the next tick snaps across the gap.
    const r2 = advancePlayhead({
      ...base,
      times,
      playheadMs: sec(31),
      toMs: sec(9 * 3600),
    });
    expect(r2).toEqual({ playheadMs: sec(8 * 3600), ended: false });
  });

  it("parks on the final frame instead of running out into empty time", () => {
    const times = [sec(0), sec(10)];
    const r = advancePlayhead({ ...base, times, playheadMs: sec(50) });
    expect(r).toEqual({ playheadMs: sec(10), ended: true });
  });

  it("ends at the window edge", () => {
    const times = [sec(0), sec(100), sec(200)];
    const r = advancePlayhead({ ...base, times, playheadMs: sec(197), toMs: sec(200) });
    expect(r.ended).toBe(true);
    expect(r.playheadMs).toBe(sec(200));
  });

  it("does not deadlock on an empty frame set", () => {
    const r = advancePlayhead({ ...base, times: [], playheadMs: sec(0) });
    expect(r).toEqual({ playheadMs: sec(0), ended: true });
  });

  it("scales gap-skipping with the tick size", () => {
    // At 30m/s a tick covers 180s of history, so the hold must exceed it or every
    // tick would look like an idle gap and playback would degenerate into
    // frame-stepping — the exact behaviour this replaced.
    const times = [sec(0), sec(120), sec(240)];
    const fast = { times, perTickMs: 180_000, holdMs: 270_000, toMs: sec(3_600) };
    const r = advancePlayhead({ ...fast, playheadMs: sec(0) });
    expect(r).toEqual({ playheadMs: sec(180), ended: false });
  });
});
