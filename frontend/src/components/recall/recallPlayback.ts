/**
 * Playhead arithmetic for the Recall player.
 *
 * Pure and separate from the component because this is the part that is easy to get
 * subtly wrong: keyframes are captured on change rather than on a clock, so the gap
 * between two frames carries meaning and advancing the playhead is not "next index".
 */

/**
 * Index of the frame at-or-before `ms` in an ascending `times` array, or the first
 * frame when `ms` precedes them all. `-1` for an empty array.
 *
 * Binary search: this runs on every playback tick and on every pixel of a scrub
 * drag, over ranges that hold thousands of keyframes.
 */
export function frameIndexAt(times: number[], ms: number): number {
  if (times.length === 0) return -1;
  if (ms <= times[0]) return 0;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface AdvanceArgs {
  /** Frame capture times, ascending. */
  times: number[];
  /** Current playhead, epoch ms. */
  playheadMs: number;
  /** History-ms this tick covers (tick length × speed rate). */
  perTickMs: number;
  /**
   * How long the playhead may linger past the current frame before an idle gap is
   * skipped. Scaled by the rate by the caller, so gap-skipping means the same thing
   * at every speed.
   */
  holdMs: number;
  /** End of the loaded window; playback stops here. */
  toMs: number;
}

export interface AdvanceResult {
  /** Where the playhead should land. */
  playheadMs: number;
  /** True when playback has run out of history and should stop. */
  ended: boolean;
}

/**
 * Advance the playhead one tick, collapsing idle gaps.
 *
 * The player this replaces stepped one array index per tick, so eight hours of an
 * idle overnight gap played at exactly the same speed as a busy minute of work.
 * Here the playhead moves in real time — which keeps it consistent with the
 * scrubber, the activity histogram and the day ribbon — and jumps straight to the
 * next frame once it has sat past the current one for longer than `holdMs`. Long
 * stretches of nothing are skipped; the density of what's left is preserved.
 */
export function advancePlayhead({
  times,
  playheadMs,
  perTickMs,
  holdMs,
  toMs,
}: AdvanceArgs): AdvanceResult {
  if (times.length === 0) return { playheadMs, ended: true };
  const last = times[times.length - 1];
  let next = playheadMs + perTickMs;

  const i = frameIndexAt(times, next);
  if (i >= 0 && next - times[i] > holdMs) {
    const ahead = times[i + 1];
    // Nothing further to show: park on the final frame rather than running the
    // playhead out into empty time past it.
    if (ahead === undefined) return { playheadMs: last, ended: true };
    next = ahead;
  }
  if (next >= toMs) return { playheadMs: Math.min(toMs, last), ended: true };
  return { playheadMs: next, ended: false };
}
