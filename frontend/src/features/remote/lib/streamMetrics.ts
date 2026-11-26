/**
 * Delivery measurements a transport reports for the active stream. They measure received bytes across the combined agent → server → browser path
 * and local decoding, not link capacity or Wi-Fi signal. Transfer time excludes
 * waiting for the first byte, so static-screen silence is not congestion.
 */
export interface StreamMetricsSink {
  /** A complete frame arrived. Null transfer time means the transport cannot measure it. */
  frame: (
    bytes: number,
    transferMs: number | null,
    timing?: { sourceMs: number; arrivalMs: number; capture: string },
  ) => void;
  /** A frame finished decoding after this many milliseconds. */
  decoded: (ms: number) => void;
  /** A received frame was discarded before display because decoding could not keep up. */
  dropped: () => void;
}

/** Active byte-transfer/decode pressure, never FPS (unchanged desktops are quiet).
 * Three pressured windows lower a tier; six healthy windows recover one tier.
 * Windows require at least eight frames and 2s, with a 10s settling cooldown.
 */
export class AutoStreamController {
  constructor(readonly scope = "") {}
  tier = 2;
  private started = 0;
  private frames = 0;
  private bytes = 0;
  private transfer = 0;
  private decode = 0;
  private drops = 0;
  private previousTiming: { sourceMs: number; arrivalMs: number; capture: string } | undefined;
  private delayed = 0;
  private measured = 0;
  private timely = 0;
  private bad = 0;
  private good = 0;
  private cooldown = 0;
  reset(now: number) {
    this.tier = 2;
    this.previousTiming = undefined;
    this.started = now;
    this.cooldown = now + 10_000;
    this.bad = this.good = 0;
    this.clear();
  }
  private clear() {
    this.frames =
      this.bytes =
      this.transfer =
      this.decode =
      this.drops =
      this.delayed =
      this.measured =
      this.timely =
        0;
  }
  frame(
    bytes: number,
    transferMs: number | null,
    timing?: { sourceMs: number; arrivalMs: number; capture: string },
  ) {
    const previous = this.previousTiming;
    if (timing && previous && timing.capture === previous.capture) {
      const sourceDelta = timing.sourceMs - previous.sourceMs;
      const arrivalDelta = timing.arrivalMs - previous.arrivalMs;
      if (
        sourceDelta > 0 &&
        sourceDelta < 1000 &&
        arrivalDelta >= 0 &&
        arrivalDelta <= sourceDelta + 50
      )
        this.timely++;
      // Growing delivery lag needs no synchronized agent/browser clock.
      // Ignore duplicates, capture resets and sparse/static source updates.
      if (
        sourceDelta > 0 &&
        sourceDelta < 1000 &&
        arrivalDelta < 2000 &&
        arrivalDelta - sourceDelta > 50
      )
        this.delayed++;
    }
    this.previousTiming = timing;
    this.frames++;
    this.bytes += bytes;
    if (transferMs !== null && transferMs > 0) {
      this.transfer += transferMs;
      this.measured++;
    }
  }
  decoded(ms: number) {
    this.decode += ms;
  }
  dropped() {
    this.drops++;
  }
  sample(now: number, intervalMs: number): number {
    if (this.frames < 8 && now - this.started > 5000) {
      this.clear();
      this.bad = this.good = 0;
      this.started = now;
    }
    if (now - this.started < 2000 || this.frames < 8) return this.tier;
    const pressured =
      this.delayed / this.frames > 0.3 ||
      this.drops / this.frames > 0.1 ||
      this.decode / this.frames > intervalMs * 0.8 ||
      (this.bytes > 64_000 && this.transfer / this.frames > intervalMs * 1.3);
    const healthy =
      (this.measured >= this.frames * 0.8 || this.timely >= this.frames * 0.8) &&
      this.delayed === 0 &&
      this.drops === 0 &&
      this.decode / this.frames < intervalMs * 0.4 &&
      this.transfer / this.frames < intervalMs * 0.6;
    this.bad = pressured ? this.bad + 1 : 0;
    this.good = healthy ? this.good + 1 : 0;
    if (now >= this.cooldown && (this.bad >= 3 || this.good >= 6)) {
      this.tier = Math.max(0, Math.min(3, this.tier + (this.bad >= 3 ? -1 : 1)));
      this.cooldown = now + 10_000;
      this.bad = this.good = 0;
    }
    this.started = now;
    this.clear();
    return this.tier;
  }
}
