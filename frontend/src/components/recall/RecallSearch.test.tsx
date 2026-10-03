import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecallSearch } from "./RecallSearch";
const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { historySearch: search, historyBlobUrl: () => "/image" }, errorText: (e: Error) => e.message }));
vi.mock("../ui/console", () => ({ Box: ({ children }: {children: React.ReactNode}) => <div>{children}</div>, Button: ({children, onClick, disabled}: {children: React.ReactNode; onClick: () => void; disabled: boolean}) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
let el: HTMLDivElement, root: Root;
let resolve: (value: unknown) => void;
let reject: (reason: Error) => void;
const render = (agentId = "a", monitor: number | null = 0) => act(() => root.render(<RecallSearch agentId={agentId} monitor={monitor} timezone="UTC" onSeek={vi.fn()} />));
function type(value: string) {
  act(() => {
    const input = el.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function click(label: string) { act(() => { [...el.querySelectorAll("button")].find(b => b.textContent === label)!.click(); }); }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  search.mockReset().mockImplementation(() => new Promise((res, rej) => { resolve = res; reject = rej; }));
  render();
});
afterEach(() => { act(() => root.unmount()); el.remove(); });
describe("Recall search request scope", () => {
  it.each(["query", "clear", "agent", "monitor"])("discards late results after %s changes", async (change) => {
    type("old"); click("Search");
    if (change === "query") type("new");
    if (change === "clear") click("Clear");
    if (change === "agent") render("b", 0);
    if (change === "monitor") render("a", 1);
    await act(async () => resolve({ results: [{ id: 1, captured_at: "2026-10-03T00:00:00Z", snippet: "obsolete hit" }] }));
    expect(el.textContent).not.toContain("obsolete hit");
    if (change !== "query") expect(el.querySelector("input")!.value).toBe("");
  });
  it("discards obsolete errors without hiding a newer request", async () => {
    type("old"); click("Search"); const oldReject = reject;
    type("new"); click("Search");
    await act(async () => oldReject(new Error("obsolete failure")));
    expect(el.textContent).not.toContain("obsolete failure");
    await act(async () => resolve({ results: [{ id: 2, captured_at: "2026-10-03T00:00:00Z", snippet: "current hit" }] }));
    expect(el.textContent).toContain("current hit");
  });
});

it("freezes retained search scope and deduplicates cursor overlaps", async () => {
  type("needle"); click("Search");
  const initial = search.mock.calls[0][2];
  expect(initial).toMatchObject({scope: "retained", sort: "ranked", monitor: 0, limit: 100});
  expect(initial.from).toBeUndefined();
  await act(async () => resolve({results: [{id: 1, captured_at: "2026-10-03T00:00:00Z", snippet: "first"}], next_cursor: "next", has_more: true, complete: false}));
  click("Load more");
  expect(search.mock.calls[1][2]).toEqual({...initial, cursor: "next"});
  await act(async () => resolve({results: [{id: 1, captured_at: "2026-10-03T00:00:00Z", snippet: "first"}, {id: 2, captured_at: "2026-10-03T01:00:00Z", snippet: "second"}], complete: true}));
  expect(el.textContent).toContain("2 matches loaded");
  expect(el.textContent).toContain("Search complete");
  expect(el.textContent).not.toContain("Load more");
});
it("clear invalidates a pending continuation", async () => {
  type("needle"); click("Search");
  await act(async () => resolve({results: [], next_cursor: "next"}));
  click("Load more"); click("Clear");
  await act(async () => resolve({results: [{id: 3, captured_at: "2026-10-03T00:00:00Z", snippet: "late page"}]}));
  expect(el.textContent).not.toContain("late page");
});
it("changing sort invalidates pending results and sends newest order", async () => {
  type("needle"); click("Search"); const old = resolve;
  act(() => { const select = el.querySelector<HTMLSelectElement>('[aria-label="Search order"]')!; select.value = "newest"; select.dispatchEvent(new Event("change", {bubbles: true})); });
  click("Search");
  expect(search.mock.calls[1][2].sort).toBe("newest");
  await act(async () => old({results: [{id: 4, captured_at: "2026-10-03T00:00:00Z", snippet: "obsolete sort"}]}));
  expect(el.textContent).not.toContain("obsolete sort");
});
it("freezes selected playback bounds and invalidates pages when those bounds change", async () => {
  const show = (toMs: number) => act(() => root.render(<RecallSearch agentId="a" monitor={0} timezone="UTC" range={{fromMs: 1000, toMs}} onSeek={vi.fn()} />));
  show(2000); type("needle");
  act(() => { const select = el.querySelector<HTMLSelectElement>('[aria-label="Search scope"]')!; select.value = "selected"; select.dispatchEvent(new Event("change", {bubbles: true})); });
  click("Search"); expect(search.mock.calls[0][2]).toMatchObject({scope: "range", from: "1970-01-01T00:00:01.000Z", to: "1970-01-01T00:00:02.000Z"});
  await act(async () => resolve({results: [], next_cursor: "next"})); click("Load more"); show(3000);
  await act(async () => resolve({results: [{id: 8, captured_at: "2026-10-03T00:00:00Z", snippet: "obsolete window"}]}));
  expect(el.textContent).not.toContain("obsolete window"); expect(el.textContent).not.toContain("Load more");
});
it("saves and reruns the exact scoped query locally", async () => {
  localStorage.removeItem("search-test:searches");
  act(() => root.render(<RecallSearch agentId="a" monitor={0} timezone="UTC" preferencesKey="search-test" onSeek={vi.fn()} />));
  type("saved needle"); click("Search"); await act(async () => resolve({results: [], complete: true})); click("Save search");
  expect(JSON.parse(localStorage.getItem("search-test:searches")!)[0]).toMatchObject({query: "saved needle", scope: "retained", sort: "ranked", monitor: 0});
  click("Clear"); act(() => [...el.querySelectorAll("button")].find(b => b.textContent?.startsWith("Run saved:"))!.click());
  expect(search.mock.calls[1].slice(0, 2)).toEqual(["a", "saved needle"]);
});
it("seeks the hit's display when all-display hits share a timestamp", async () => {
  const seek = vi.fn();
  act(() => root.render(<RecallSearch agentId="a" monitor={null} timezone="UTC" onSeek={seek} />));
  type("needle"); click("Search");
  const at = "2026-10-03T01:00:00Z";
  await act(async () => resolve({results: [
    {id: 10, captured_at: at, monitor: 0, snippet: "first display hit"},
    {id: 11, captured_at: at, monitor: 1, snippet: "second display hit"},
  ], complete: true}));
  const hit = (snippet: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.includes(snippet))!;
  act(() => hit("second display hit").click()); expect(seek).toHaveBeenLastCalledWith(at, 1);
  act(() => hit("first display hit").click()); expect(seek).toHaveBeenLastCalledWith(at, 0);
});
it("expands grouped captures to exact recordings and preserves expansion across continuation", async () => {
  const seek = vi.fn();
  act(() => root.render(<RecallSearch agentId="a" monitor={null} timezone="UTC" onSeek={seek} />));
  const frame = (id: number) => ({ id, captured_at: new Date(Date.UTC(2026, 9, 3, 1, id)).toISOString(), monitor: 1, w: 1920, h: 1080, phash: "12345", snippet: "similar needle" });
  type("needle"); click("Search");
  await act(async () => resolve({ results: [frame(1), frame(2)], has_more: true, next_cursor: "more", complete: false }));
  const details = el.querySelector("details")!;
  expect(details.querySelector("summary")!.textContent).toContain("2 similar captures");
  act(() => details.querySelector("summary")!.click()); expect(details.open).toBe(true);
  act(() => details.querySelectorAll("button")[1].click());
  expect(seek).toHaveBeenLastCalledWith(frame(2).captured_at, 1);
  click("Load more"); await act(async () => resolve({ results: [frame(2), frame(3)], complete: true }));
  expect(el.querySelector("details")!.open).toBe(true); expect(el.querySelector("summary")!.textContent).toContain("3 similar captures");
  expect(el.querySelector("details")!.querySelectorAll("button")).toHaveLength(3);
  act(() => el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(el.querySelector("details")).toBeNull();
  expect(el.textContent).toContain("3 matches loaded");
});
