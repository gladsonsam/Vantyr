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
