import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RecallView } from "@/features/recall/components/RecallView";
import { preferenceKey } from "@/features/recall/lib/recallRetrieval";
const { api } = vi.hoisted(() => ({ api: {
  me: vi.fn(), historyMonitors: vi.fn(), historyFrames: vi.fn(), historyActivity: vi.fn(),
  historyDaySummary: vi.fn(), historySegments: vi.fn(), historyFrameAt: vi.fn(),
} }));
vi.mock("@/api", () => ({api, errorText: (e: Error) => e.message}));
vi.mock("@/features/recall/components/RecallSearch", () => ({RecallSearch: () => null}));
vi.mock("@/features/recall/components/RecallPlayer", () => ({RecallPlayer: (p: {frames: {id: number}[]; playheadMs: number; monitor: number | null}) => <output>{JSON.stringify({ids: p.frames.map(f => f.id), at: p.playheadMs, monitor: p.monitor})}</output>}));

it("passes the actual displayed frame to navigation and restores its exact display from an all-display gap", async () => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const capture = "2026-10-03T01:00:00.000Z", target = "2026-10-03T01:05:00.000Z";
  const frames = [
    {id: 41, captured_at: capture, monitor: 0},
    {id: 42, captured_at: capture, monitor: 1},
    {id: 43, captured_at: "2026-10-03T01:10:00.000Z", monitor: 0},
  ];
  api.me.mockResolvedValue({id: "user"});
  // No default display: the loaded metadata represents an all-display window.
  api.historyMonitors.mockResolvedValue({monitors: []});
  api.historyFrames.mockImplementation((_device, opts) => Promise.resolve({frames: frames.filter(f => opts.monitor == null || f.monitor === opts.monitor), complete: true}));
  api.historyActivity.mockResolvedValue({points: [], bucket_secs: 60});
  api.historyDaySummary.mockResolvedValue({summary: null, timezone: "Australia/Perth"});
  api.historySegments.mockResolvedValue({segments: [], timezone: "Australia/Perth"});
  api.historyFrameAt.mockImplementation((_device, at, monitor) => Promise.resolve({frame: frames.find(f => f.captured_at === at && f.monitor === monitor) ?? null}));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent === text)!;
  try {
    await act(async () => root.render(<RecallView agentId="device" initialAtIso={target} />));
    expect(JSON.parse(el.querySelector("output")!.textContent!)).toMatchObject({at: Date.parse(target), monitor: null});
    await act(async () => button("Copy link to current moment").click());
    const url = new URL(writeText.mock.calls[0][0]);
    expect(url.searchParams.get("at")).toBe(capture); expect(url.searchParams.get("monitor")).toBe("1");
    act(() => button("Bookmark current moment").click());
    const stored = JSON.parse(localStorage.getItem(`${preferenceKey("user", "device")}:bookmarks`)!);
    expect(stored[0]).toMatchObject({frameId: 42, at: capture, monitor: 1});
    await act(async () => [...el.querySelectorAll("button")].find(b => b.textContent?.includes("Display 2"))!.click());
    expect(api.historyFrameAt).toHaveBeenCalledWith("device", capture, 1);
    expect(JSON.parse(el.querySelector("output")!.textContent!)).toMatchObject({ids: [42], at: Date.parse(capture), monitor: 1});
    expect(el.textContent).not.toContain("missing or expired");
  } finally { act(() => root.unmount()); el.remove(); }
});
