import { expect, test } from "bun:test";
import { AutoStreamController } from "@/features/remote/lib/streamMetrics";

function window(c: AutoStreamController, now: number, slow = false) {
  for (let i = 0; i < 16; i++) {
    c.frame(100_000, slow ? 100 : 2);
    c.decoded(slow ? 50 : 2);
  }
  return c.sample(now, 33);
}
test("Auto warms up, backs off under sustained pressure, and recovers slowly", () => {
  const c = new AutoStreamController();
  c.reset(0);
  window(c, 2000, true);
  window(c, 4000, true);
  expect(window(c, 6000, true)).toBe(2);
  expect(window(c, 10000, true)).toBe(1);
  for (let i = 1; i <= 5; i++) expect(window(c, 10000 + i * 2000)).toBe(1);
  expect(window(c, 22000)).toBe(2);
  c.reset(23000);
  expect(c.tier).toBe(2);
});
test("silent/static screen is neither congestion nor recovery evidence", () => {
  const c = new AutoStreamController();
  c.reset(0);
  for (let t = 2000; t < 100000; t += 2000) expect(c.sample(t, 33)).toBe(2);
});
test("decode drops cause backoff even when transfers are fast", () => {
  const c = new AutoStreamController();
  c.reset(0);
  for (let t = 2000; t <= 10000; t += 2000) {
    for (let i = 0; i < 16; i++) {
      c.frame(2000, 0);
      c.dropped();
    }
    c.sample(t, 33);
  }
  expect(c.tier).toBe(1);
});
test("growing agent-to-browser lag backs off even for single-chunk packets", () => {
  const c = new AutoStreamController();
  c.reset(0);
  let n = 0;
  for (let t = 2000; t <= 10000; t += 2000) {
    for (let i = 0; i < 16; i++) {
      n++;
      c.frame(100000, 0, { sourceMs: n * 33, arrivalMs: n * 133, capture: "same" });
    }
    c.sample(t, 33);
  }
  expect(c.tier).toBe(1);
});
test("sparse heartbeats do not build healthy or congested windows", () => {
  const c = new AutoStreamController();
  c.reset(0);
  for (let t = 2000; t < 100000; t += 2000) {
    if (t % 10000 === 0) c.frame(100000, 1, { sourceMs: 1, arrivalMs: t, capture: "static" });
    expect(c.sample(t, 33)).toBe(2);
  }
});
test("unknown or zero transfer timing never proves recovery", () => {
  for (const transfer of [null, 0]) {
    const c = new AutoStreamController();
    c.reset(0);
    for (let t = 2000; t <= 40000; t += 2000) {
      for (let i = 0; i < 16; i++) {
        c.frame(100000, transfer);
        c.decoded(2);
      }
      expect(c.sample(t, 33)).toBe(2);
    }
  }
});
