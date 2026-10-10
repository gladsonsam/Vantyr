import { observedContext } from "@/features/recall/__fixtures__/context";
import { EMPTY_CONTEXT_FILTERS, parseRecallFilters } from "@/features/recall/lib/recallContext";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecallSearch } from "@/features/recall/components/RecallSearch";
const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/api", () => ({ api: { historySearch: search, historyBlobUrl: () => "/image" }, errorText: (e: Error) => e.message }));
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
  act(() => hit("second display hit").click()); expect(seek).toHaveBeenLastCalledWith(at, 1,11);
  act(() => hit("first display hit").click()); expect(seek).toHaveBeenLastCalledWith(at, 0,10);
});
it("expands grouped captures to exact recordings and preserves expansion across continuation", async () => {
  const seek = vi.fn();
  act(() => root.render(<RecallSearch agentId="a" monitor={null} timezone="UTC" onSeek={seek} />));
  const frame = (id: number) => ({ id, captured_at: new Date(Date.UTC(2026, 9, 3, 1, id)).toISOString(), monitor: 1, w: 1920, h: 1080, phash: "12345", snippet: "similar needle" });
  type("needle"); click("Search");
  await act(async () => resolve({ results: [frame(1), frame(2)], has_more: true, next_cursor: "more", complete: false }));
  const details = el.querySelector<HTMLDetailsElement>(".recall-search-group")!;
  expect(details.querySelector("summary")!.textContent).toContain("2 similar captures");
  act(() => details.querySelector("summary")!.click()); expect(details.open).toBe(true);
  act(() => details.querySelectorAll("button")[1].click());
  expect(seek).toHaveBeenLastCalledWith(frame(2).captured_at, 1,2);
  click("Load more"); await act(async () => resolve({ results: [frame(2), frame(3)], complete: true }));
  expect(el.querySelector<HTMLDetailsElement>(".recall-search-group")!.open).toBe(true); expect(el.querySelector(".recall-search-group summary")!.textContent).toContain("3 similar captures");
  expect(el.querySelector<HTMLDetailsElement>(".recall-search-group")!.querySelectorAll("button")).toHaveLength(3);
  act(() => el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(el.querySelector<HTMLDetailsElement>(".recall-search-group")).toBeNull();
  expect(el.textContent).toContain("3 matches loaded");
});

function field(label:string,value:string) {
  act(()=>{const input=el.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}"]`)!;const proto=input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(input,value);input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input",{bubbles:true}));});
}
it("keeps OCR defaults, allows context-only newest search, echoes exact filters and freezes continuation",async()=>{
  field("Foreground app around capture","Editor.EXE");field("App match","prefix");field("Foreground title contains","Docs %_");click("Search");
  expect(search.mock.calls[0][1]).toBe("");const initial=search.mock.calls[0][2];expect(initial).toMatchObject({app:"editor.exe",app_mode:"prefix",title:"Docs %_",context:"all",sort:"newest"});
  expect(el.textContent).toContain("Context-only search shows newest captures");
  await act(async()=>resolve({query:"",sort:"newest",filters:filterEcho(initial),results:[{id:1,captured_at:"2026-10-03T00:00:00Z",monitor:1,rank:0,snippet:"",context:observedContext}],next_cursor:"frozen",complete:false}));
  click("Load more");expect(search.mock.calls[1][2]).toEqual({...initial,cursor:"frozen"});const stale=resolve;
  field("Foreground app around capture","Other.EXE");click("Search");
  await act(async()=>stale({results:[{id:9,captured_at:"2026-10-03T00:00:00Z",snippet:"obsolete context page"}],filters:filterEcho(initial),complete:true}));expect(el.textContent).not.toContain("obsolete context page");
  expect(search.mock.calls[2][2].app).toBe("other.exe");
});
it("unknown context includes old rows and incompatible value filters require clear recovery",async()=>{
  field("Capture context","unknown");click("Search");expect(search.mock.calls[0][2]).toMatchObject({context:"unknown",sort:"newest"});
  await act(async()=>resolve({filters:{...EMPTY_CONTEXT_FILTERS,context:"unknown"},results:[{id:1,captured_at:"2026-10-03T00:00:00Z",snippet:"",context:null}],complete:true}));expect(el.textContent).toContain("No context recorded (older or unavailable metadata)");
  field("Foreground app around capture","editor.exe");expect(el.querySelector('[role="alert"]')?.textContent).toContain("cannot be combined");click("Clear filters");expect(el.querySelector('[role="alert"]')).toBeNull();
  type("OCR needle");click("Search");expect(search.mock.calls[1][2]).toMatchObject({sort:"ranked"});expect(search.mock.calls[1][2].app).toBeUndefined();
});
it("restores saved context searches and clears stale results/feedback on user/server scope switches",async()=>{
  localStorage.removeItem("context-saved:searches");act(()=>root.render(<RecallSearch agentId="a" monitor={0} timezone="UTC" preferencesKey="context-saved" onSeek={vi.fn()}/>));
  field("Foreground app around capture","Editor.EXE");click("Search");await act(async()=>resolve({filters:parseRecallFilters({app:"editor.exe"}),results:[],complete:true}));click("Save search");
  expect(JSON.parse(localStorage.getItem("context-saved:searches")!)[0]).toMatchObject({query:"",sort:"newest",filters:{app:"editor.exe",app_mode:"exact",context:"all"}});
  click("Clear");act(()=>[...el.querySelectorAll("button")].find(button=>button.textContent?.startsWith("Run saved:"))!.click());expect(search.mock.calls[1][2]).toMatchObject({app:"editor.exe",sort:"newest"});const old=resolve;
  act(()=>root.render(<RecallSearch agentId="a" monitor={0} timezone="UTC" preferencesKey="another-user-server" onSeek={vi.fn()}/>));
  expect(el.textContent).not.toContain("Run saved:");await act(async()=>old({filters:parseRecallFilters({app:"editor.exe"}),results:[{id:8,captured_at:"2026-10-03T00:00:00Z",snippet:"other user result"}],complete:true}));expect(el.textContent).not.toContain("other user result");expect(search.mock.calls[1][3].aborted).toBe(true);
});
it("fails clearly if a legacy server ignores active filters, and renders hit titles as literal text",async()=>{
  field("Capture context","known");click("Search");await act(async()=>resolve({results:[{id:9,captured_at:"2026-10-03T00:00:00Z",snippet:"unfiltered"}],complete:true}));expect(el.textContent).toContain("does not support");expect(el.textContent).not.toContain("unfiltered");
  click("Clear filters");type("needle");click("Search");const text="<img src=x onerror=alert(1)>";
  await act(async()=>resolve({results:[{id:10,captured_at:"2026-10-03T00:00:00Z",monitor:1,snippet:text,context:{...observedContext,window:{...observedContext.window,title:text}}}],complete:true}));
  expect(el.textContent).toContain(text);expect(el.querySelector('[onerror]')).toBeNull();expect(el.querySelector("script")).toBeNull();
});

function filterEcho(opts:Record<string,unknown>) {return parseRecallFilters({app:opts.app,app_mode:opts.app_mode,title:opts.title,url_host:opts.url_host,context:opts.context});}

it("restores a linked all-display context search independently of the playback monitor",()=>{
  act(()=>root.render(<RecallSearch key="linked" agentId="a" monitor={1} timezone="UTC" onSeek={vi.fn()} initialSearch={{query:"",scope:"retained",sort:"newest",monitor:null,filters:parseRecallFilters({context:"unknown"})}}/>));
  click("Search");expect(search.mock.calls[0][2]).toMatchObject({monitor:null,context:"unknown",sort:"newest"});expect(el.textContent).toContain("on all displays");
});
