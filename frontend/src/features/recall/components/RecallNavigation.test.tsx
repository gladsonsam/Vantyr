import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecallNavigation } from "./RecallNavigation";
const { frameAt } = vi.hoisted(() => ({ frameAt: vi.fn() }));
vi.mock("@/api", () => ({ api: {historyFrameAt: frameAt} }));
let el: HTMLDivElement, root: Root;
const seek = vi.fn(), range = vi.fn(), monitor = vi.fn();
function click(label: string) { act(() => { [...el.querySelectorAll("button")].find(b => b.textContent === label)!.click(); }); }
function input(label: string, value: string) { act(() => { const field = [...el.querySelectorAll("label")].find(l => l.textContent === label)!.querySelector("input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", {bubbles: true})); }); }
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); seek.mockReset(); range.mockReset(); monitor.mockReset(); frameAt.mockReset();
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  act(() => root.render(<RecallNavigation agentId="device" timezone="Australia/Perth" atMs={Date.parse("2026-10-03T01:00:00Z")} monitor={1} displayedFrame={{ id: 42, captured_at: "2026-10-03T01:00:00.000Z", monitor: 1 }} preferencesKey="test-scope" onSeek={seek} onRange={range} onMonitor={monitor} />));
});
afterEach(() => { act(() => root.unmount()); el.remove(); });
it("jumps and loads custom ranges in device time, rejecting reversed ranges", () => {
  input("Jump to time ", "2026-10-03T09:15"); click("Jump"); expect(seek).toHaveBeenCalledWith("2026-10-03T01:15:00.000Z");
  input("Range from ", "2026-10-03T10:00"); input("Range to ", "2026-10-03T09:00"); click("Load custom range"); expect(range).not.toHaveBeenCalled();
  input("Range to ", "2026-10-03T11:00"); click("Load custom range"); expect(range).toHaveBeenCalledWith({fromMs: Date.parse("2026-10-03T02:00:00Z"), toMs: Date.parse("2026-10-03T03:00:00Z")});
});
it("copies the current instant immediately and provides a selectable fallback when denied", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
  await act(async () => click("Copy link to current moment"));
  const url = new URL(writeText.mock.calls[0][0]);
  expect(url.searchParams.get("at")).toBe("2026-10-03T01:00:00.000Z"); expect(url.searchParams.get("monitor")).toBe("1");
  expect(el.textContent).toContain("Clipboard unavailable"); expect(el.querySelector<HTMLInputElement>("input[readonly]")!.value).toBe(url.href);
  writeText.mockResolvedValue(undefined); await act(async () => click("Copy link to current moment")); expect(el.textContent).toContain("Moment link copied"); expect(el.querySelector("input[readonly]")).toBeNull();
});
it("retains local notes when a bookmarked recording expires and opens only the exact recorded frame", async () => {
  input("Bookmark note ", "investigate later"); click("Bookmark current moment");
  expect(JSON.parse(localStorage.getItem("test-scope:bookmarks")!)[0]).toMatchObject({frameId: 42, note: "investigate later", monitor: 1});
  const bookmarkButton = () => [...el.querySelectorAll("button")].find(b => b.textContent?.includes("Display 2"))!;
  frameAt.mockResolvedValue({frame: {id: 99}}); await act(async () => bookmarkButton().click()); expect(el.textContent).toContain("missing or expired"); expect(seek).not.toHaveBeenCalled();
  frameAt.mockResolvedValue({frame: {id: 42}}); await act(async () => bookmarkButton().click()); expect(seek).toHaveBeenCalledWith("2026-10-03T01:00:00.000Z"); expect(monitor).toHaveBeenCalledWith(1);
  click("Remove bookmark"); expect(JSON.parse(localStorage.getItem("test-scope:bookmarks")!)).toEqual([]);
});
it("bookmarks and copies exact displayed frame coordinates during an all-display playhead gap", async () => {
  const at = "2026-10-03T01:00:00.000Z";
  act(() => root.render(<RecallNavigation agentId="device" timezone="Australia/Perth" atMs={Date.parse("2026-10-03T01:05:00Z")} monitor={null}
    displayedFrame={{id: 42, captured_at: at, monitor: 1}} preferencesKey="test-scope" onSeek={seek} onRange={range} onMonitor={monitor} />));
  click("Bookmark current moment");
  expect(JSON.parse(localStorage.getItem("test-scope:bookmarks")!)[0]).toMatchObject({frameId: 42, at, monitor: 1});
  expect(el.textContent).toContain("Display 2"); expect(el.textContent).not.toContain("All displays");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
  await act(async () => click("Copy link to current moment"));
  const url = new URL(writeText.mock.calls[0][0]);
  expect(url.searchParams.get("at")).toBe(at); expect(url.searchParams.get("monitor")).toBe("1");
  frameAt.mockImplementation((_device, instant, display) => Promise.resolve({frame: {id: instant === at && display === 1 ? 42 : 99}}));
  await act(async () => [...el.querySelectorAll("button")].find(b => b.textContent?.includes("Display 2"))!.click());
  expect(frameAt).toHaveBeenCalledWith("device", at, 1); expect(seek).toHaveBeenCalledWith(at); expect(monitor).toHaveBeenCalledWith(1);
  expect(el.textContent).not.toContain("missing or expired");
});
