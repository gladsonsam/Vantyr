import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RecallView } from "@/features/recall/components/RecallView";
const { api } = vi.hoisted(() => ({ api: { historyMonitors: vi.fn(), historyFrames: vi.fn(), historyActivity: vi.fn(), historyDaySummary: vi.fn(), historySegments: vi.fn() } }));
vi.mock("@/api", () => ({ api, errorText: (e: Error) => e.message }));
vi.mock("@/features/recall/components/RecallSearch", () => ({ RecallSearch: () => null }));
vi.mock("@/features/recall/components/RecallPlayer", () => ({ RecallPlayer: (p: {frames: {id: number}[]; playheadMs: number; loading: boolean; monitor: number}) => <output>{JSON.stringify({ids: p.frames.map(f => f.id), at: p.playheadMs, loading: p.loading, monitor: p.monitor})}</output> }));
it("preserves a shared seek through StrictMode and every frame page, then clears frames on device change", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const at = "2026-10-03T01:00:00Z";
  let finish!: (v: unknown) => void;
  const page = (id: number, captured_at: string) => ({id, captured_at, monitor: 1, w: 100, h: 100, phash: "0", has_ocr: false});
  api.historyMonitors.mockResolvedValue({monitors: [{monitor: 1, frame_count: 2}]});
  api.historyActivity.mockResolvedValue({points: [], bucket_secs: 60});
  api.historyDaySummary.mockResolvedValue({summary: null, timezone: "Australia/Perth"});
  api.historySegments.mockResolvedValue({segments: [], timezone: "Australia/Perth"});
  api.historyFrames.mockImplementation((_agent, opts) => opts.cursor ? new Promise(res => { finish = res; }) : Promise.resolve({frames: [page(1, "2026-10-03T00:45:00Z")], next_cursor: "page2", complete: false}));
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el); const changed = vi.fn();
  const render = (agentId: string) => act(async () => root.render(<StrictMode><RecallView agentId={agentId} initialAtIso={at} initialDay="2026-10-03" initialMonitor={1} onStateChange={changed}/></StrictMode>));
  try {
    await render("a");
    expect(el.textContent).toContain("1 frames loaded");
    expect(changed).not.toHaveBeenCalled();
    await act(async () => finish({frames: [page(2, at)], complete: true, next_cursor: null}));
    expect(JSON.parse(el.querySelector("output")!.textContent!)).toMatchObject({ids: [1, 2], at: Date.parse(at), loading: false, monitor: 1});
    expect(changed).toHaveBeenLastCalledWith({day: "2026-10-03", atMs: Date.parse(at), monitor: 1});
    api.historyMonitors.mockImplementation(() => new Promise(() => {}));
    await render("b");
    expect(JSON.parse(el.querySelector("output")!.textContent!)).toMatchObject({ids: [], loading: true});
  } finally { act(() => root.unmount()); el.remove(); }
});

it("seeks day sources through existing playback and ignores stale day context responses", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  for (const method of Object.values(api)) method.mockReset();
  api.historyMonitors.mockResolvedValue({ monitors: [{ monitor: 1, frame_count: 1 }] });
  api.historyActivity.mockResolvedValue({ points: [], bucket_secs: 60 });
  api.historyFrames.mockResolvedValue({ frames: [], complete: true, next_cursor: null });
  let finishOld!: (value: unknown) => void;
  api.historyDaySummary.mockImplementation((_agent, day) => day === "2026-09-01" ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ summary: null, timezone: "Australia/Perth" }));
  api.historySegments.mockResolvedValue({ segments: [], timezone: "Australia/Perth" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const source = "2026-08-01T01:00:00Z";
  try {
    await act(async () => root.render(<RecallView agentId="a" initialDay="2026-09-01" initialMonitor={1}>{ctx => <>
      <output data-day>{JSON.stringify({ day: ctx.day, summary: ctx.summary, loading: ctx.loading, error: ctx.dayError })}</output>
      <button onClick={() => ctx.onDayChange("2026-09-02")}>Change day</button>
      <button onClick={() => ctx.onSeek(source)}>Open source</button>
    </>}</RecallView>));
    expect(JSON.parse(host.querySelector('[data-day]')!.textContent!)).toMatchObject({ loading: true, summary: null });
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Change day")!.click());
    await act(async () => finishOld({ summary: { narrative: "Stale narrative" }, timezone: "UTC" }));
    expect(JSON.parse(host.querySelector('[data-day]')!.textContent!)).toMatchObject({ day: "2026-09-02", loading: false, summary: null });
    expect(host.textContent).not.toContain("Stale narrative");
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Open source")!.click());
    const opts = api.historyFrames.mock.calls[api.historyFrames.mock.calls.length - 1][1];
    expect(opts.monitor).toBeNull();
    expect(Date.parse(opts.from)).toBeLessThan(Date.parse(source));
    expect(Date.parse(opts.to)).toBeGreaterThan(Date.parse(source));
    expect(JSON.parse(host.querySelector('[data-day]')!.textContent!)).toMatchObject({ day: "2026-08-01", loading: false });
    api.historyDaySummary.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Change day")!.click());
    expect(JSON.parse(host.querySelector('[data-day]')!.textContent!)).toMatchObject({ day: "2026-09-02", error: true, summary: null });
  } finally { act(() => root.unmount()); host.remove(); }
});
