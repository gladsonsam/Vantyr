import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecallDayPicker } from "./RecallDayPicker";
import { timeIn } from "./recallFormat";
import { RecallDayPanel } from "./RecallDayPanel";
import type { HistoryDay } from "@/api/types";
const { historyDays } = vi.hoisted(() => ({ historyDays: vi.fn() }));
vi.mock("@/api", () => ({ api: { historyDays } }));
const recording = (day: string, count = 10): HistoryDay => ({ day, frame_count: count, first_ts: null, last_ts: null, has_summary: false });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  historyDays.mockReset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-12-31T16:00:00Z"));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const render = (onChange = vi.fn(), agentId = "a", day = "2026-12-31", timezone = "Asia/Tokyo") => act(async () => root.render(<RecallDayPicker agentId={agentId} day={day} onChange={onChange} timezone={timezone}/>));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const choose = (value: string) => act(() => { const select = host.querySelector("select")!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });

it("selects covered days and steps across sparse calendar/year boundaries in the device zone", async () => {
  historyDays.mockResolvedValue({ days: [recording("2027-01-01", 30), recording("2026-12-29", 0), recording("2026-12-30", 20)] });
  const changed = vi.fn(); await render(changed);
  expect(host.querySelector('input[type="date"]')!.getAttribute("max")).toBe("2027-01-01");
  expect(host.querySelector("select")!.textContent).toContain("2027-01-01 · 30 frames");
  expect(host.querySelector("select")!.textContent).not.toContain("2026-12-29");
  choose("2026-12-30"); expect(changed).toHaveBeenLastCalledWith("2026-12-30");
  act(() => button("Previous recorded day").click()); expect(changed).toHaveBeenLastCalledWith("2026-12-30");
  act(() => button("Next recorded day").click()); expect(changed).toHaveBeenLastCalledWith("2027-01-01");
  await render(changed, "a", "2027-01-01"); expect(button("Next recorded day").disabled).toBe(true);
  await render(changed, "a", "2026-12-30"); expect(button("Previous recorded day").disabled).toBe(true);
  const date = host.querySelector<HTMLInputElement>('input[type="date"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(date, "2026-12-28"); date.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(changed).toHaveBeenLastCalledWith("2026-12-28");
});

it("keeps a dense informational overview and labelled 44px selection controls at narrow widths", async () => {
  historyDays.mockResolvedValue({ days: [recording("2026-12-31")] }); await render(); host.style.width = "320px";
  const select = host.querySelector("select")!, date = host.querySelector<HTMLInputElement>('input[type="date"]')!;
  for (const control of [select, date, ...host.querySelectorAll("button")]) expect(Number.parseFloat(getComputedStyle(control).minHeight)).toBeGreaterThanOrEqual(44);
  expect(host.querySelector(`label[for="${select.id}"]`)!.textContent).toContain("Recorded day");
  expect(host.querySelector(`label[for="${date.id}"]`)!.textContent).toContain("Calendar date");
  expect(host.querySelectorAll('[role="img"] button')).toHaveLength(0);
  expect(host.querySelectorAll('[role="img"] span')).toHaveLength(84);
  expect(host.querySelector<HTMLElement>('[role="img"]')!.style.width).toBe("154px");
  expect(select.style.width).toBe("100%"); expect(date.style.minWidth).toBe("0");
});

it("does not skip a device calendar day that was skipped in the viewer timezone", async () => {
  vi.stubEnv("TZ", "Pacific/Apia"); vi.setSystemTime(new Date("2011-12-31T12:00:00Z"));
  historyDays.mockResolvedValue({ days: [recording("2011-12-30"), recording("2011-12-31")] });
  const changed = vi.fn(); await render(changed, "a", "2011-12-31", "UTC");
  expect(host.querySelector('[title="2011-12-30 · 10 frames"]')).not.toBeNull();
  act(() => button("Previous recorded day").click()); expect(changed).toHaveBeenLastCalledWith("2011-12-30");
  expect(host.querySelectorAll('[role="img"] span')).toHaveLength(84);
  const titles = [...host.querySelectorAll('[role="img"] span')].map(cell => cell.getAttribute("title")!.split(" · ")[0]);
  expect(new Set(titles).size).toBe(84);
});

it("distinguishes loading, failed/retry and empty coverage, ignoring delayed device results", async () => {
  let resolveOld!: (value: { days: HistoryDay[] }) => void, resolveRetry!: (value: { days: HistoryDay[] }) => void;
  historyDays.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
  await render(); expect(host.textContent).toContain("Loading recorded-day coverage"); expect(host.textContent).not.toContain("No recordings found");
  expect(host.querySelector("select")!.disabled).toBe(true);
  await render(vi.fn(), "b"); expect(host.querySelector('[role="alert"]')!.textContent).toContain("Could not load"); expect(host.textContent).not.toContain("No recordings found");
  await act(async () => resolveOld({ days: [recording("2026-12-31", 999)] }));
  expect(host.textContent).not.toContain("999 frames"); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Retry coverage")!.click());
  expect(host.textContent).toContain("Loading recorded-day coverage"); expect(host.querySelector("select")!.disabled).toBe(true); expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => resolveRetry({ days: [recording("2026-12-30")] }));
  expect(historyDays.mock.calls.map(call => call[0])).toEqual(["a", "b", "b"]);
  expect(host.querySelector("select")!.textContent).toContain("2026-12-30 · 10 frames"); expect(host.querySelector('[role="alert"]')).toBeNull();
  historyDays.mockResolvedValueOnce({ days: [] }); await render(vi.fn(), "empty");
  expect(host.textContent).toContain("No recordings found in the available coverage period"); expect(host.querySelector("select")!.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[type="date"]')!.disabled).toBe(false);
});

it("ignores a delayed retry after switching devices, including switching back to the same ID", async () => {
  let resolveRetry!: (value: { days: HistoryDay[] }) => void;
  historyDays.mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }))
    .mockResolvedValueOnce({ days: [recording("2026-12-30", 22)] })
    .mockResolvedValueOnce({ days: [recording("2026-12-31", 33)] });
  await render();
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Retry coverage")!.click());
  await render(vi.fn(), "b");
  expect(host.querySelector("select")!.textContent).toContain("22 frames");
  await render(vi.fn(), "a");
  await act(async () => resolveRetry({ days: [recording("2026-12-30", 999)] }));
  expect(historyDays.mock.calls.map(call => call[0])).toEqual(["a", "a", "b", "a"]);
  expect(host.querySelector("select")!.textContent).toContain("33 frames");
  expect(host.textContent).not.toContain("999 frames");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps recorded-day navigation usable in the narrative panel's constrained flex header", async () => {
  historyDays.mockResolvedValue({ days: [recording("2026-12-30"), recording("2027-01-01", 123456)] });
  const onDayChange = vi.fn();
  await act(async () => root.render(<RecallDayPanel agentId="a" day="2026-12-31" onDayChange={onDayChange}
    summary={null} segments={[]} timezone="Asia/Tokyo" loading={false} onSeek={vi.fn()} />));
  const picker = host.querySelector<HTMLElement>(".recall-day-picker")!;
  // JSDOM does not perform layout. This asserts the parent containment contract;
  // actual control bounds are separately checked in the 320px browser viewport.
  expect(picker.parentElement!.style.flexShrink).toBe("1");
  expect(picker.parentElement!.style.minWidth).toBe("0");
  expect(picker.parentElement!.style.maxWidth).toBe("100%");
  expect(picker.style.width).toBe("100%");
  choose("2027-01-01");
  expect(onDayChange).toHaveBeenLastCalledWith("2027-01-01");
  act(() => button("Previous recorded day").click());
  expect(onDayChange).toHaveBeenLastCalledWith("2026-12-30");
});

it("reuses coverage across day changes and opens observed captures with device-zone times", async () => {
  const first = "2026-12-30T15:10:00Z", last = "2026-12-30T15:20:00Z";
  historyDays.mockResolvedValue({ timezone: "Asia/Tokyo", from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z", days: [{ ...recording("2026-12-31", 2), first_ts: first, last_ts: last }, recording("2026-12-30")] });
  const onSeek = vi.fn();
  const show = (day: string) => act(async () => root.render(<RecallDayPicker agentId="a" day={day} timezone="UTC" coverageScope="account-a" onChange={vi.fn()} onSeek={onSeek}/>));
  await show("2026-12-31");
  const facts = host.querySelector('[aria-label="Selected day retained recordings"]')!;
  expect(facts.textContent).toContain("2 retained frames on 2026-12-31");
  expect(facts.textContent).toContain(`First observed capture: ${timeIn("Asia/Tokyo", first)}`);
  expect(facts.textContent).toContain("not continuous recording");
  act(() => [...facts.querySelectorAll("button")].find(b => b.textContent === "Open first capture")!.click());
  expect(onSeek).toHaveBeenLastCalledWith(first);
  act(() => [...facts.querySelectorAll("button")].find(b => b.textContent === "Open last capture")!.click());
  expect(onSeek).toHaveBeenLastCalledWith(last);
  await show("2026-12-30");
  expect(facts.textContent).toContain("First observed capture time unavailable");
  expect(facts.querySelector("button")).toBeNull();
  await show("2026-12-29");
  expect(facts.textContent).toContain("No retained recordings reported");
  expect(facts.textContent).toContain("reason is unknown");
  await show("2026-10-01");
  expect(facts.textContent).toContain("outside the returned coverage period");
  expect(facts.textContent).not.toContain("No retained recordings");
  expect(historyDays).toHaveBeenCalledTimes(1);
});

it("hides account coverage immediately and rejects delayed results after account/day changes", async () => {
  let resolveOld!: (value: { days: HistoryDay[] }) => void;
  historyDays.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ days: [recording("2026-12-30", 22)] });
  const show = (scope: string | null, day: string) => act(async () => root.render(<RecallDayPicker agentId="a" day={day} timezone="UTC" coverageScope={scope} onChange={vi.fn()} />));
  await show("account-a", "2026-12-31");
  await show(null, "2026-12-30");
  expect(historyDays).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("coverage is loading");
  await show("account-b", "2026-12-30");
  await act(async () => resolveOld({ days: [recording("2026-12-31", 999)] }));
  expect(host.textContent).toContain("22 retained frames on 2026-12-30");
  expect(host.textContent).not.toContain("999");
  expect(historyDays).toHaveBeenCalledTimes(2);
});

it("labels narrative inference separately from recordings and uses existing source-time navigation", async () => {
  historyDays.mockResolvedValue({ days: [] });
  const onSeek = vi.fn(), first = "2026-12-31T00:00:00Z", last = "2026-12-31T01:00:00Z";
  await act(async () => root.render(<RecallDayPanel agentId="a" day="2026-12-31" onDayChange={vi.fn()} timezone="UTC" loading={false} onSeek={onSeek}
    summary={{ day: "2026-12-31", source: "ai", narrative: "Inferred synthetic work session", updated_at: null, totals: {}, top_apps: [], highlights: [{ label: "Synthetic highlight", category: "dev", start_ts: first, end_ts: last }] }}
    segments={[{ id: 1, start_ts: first, end_ts: last, app: "Synthetic editor", title: "Synthetic session", summary: null, category: "dev", distraction_score: 0, source: "rule" }]} />));
  expect(host.textContent).toContain("AI-derived inference");
  expect(host.textContent).toContain("Rule-derived");
  expect(host.textContent).toContain("Individual claims have no frame citations");
  expect(host.textContent).toContain("No retained recordings reported");
  for (const label of ["Synthetic highlight", "Synthetic session"]) {
    const source = [...host.querySelectorAll("button")].find(b => b.textContent?.includes(label))!;
    act(() => source.click()); expect(onSeek).toHaveBeenLastCalledWith(first);
  }
  expect(historyDays).toHaveBeenCalledTimes(1);
});

it("keeps day-summary errors distinct from an empty derived day", async () => {
  historyDays.mockResolvedValue({ days: [recording("2026-12-31")] });
  await act(async () => root.render(<RecallDayPanel agentId="a" day="2026-12-31" onDayChange={vi.fn()} timezone="UTC" loading={false} dayError onSeek={vi.fn()} summary={null} segments={[]} />));
  expect(host.textContent).toContain("Could not load the day summary and activity");
  expect(host.textContent).toContain("10 retained frames");
  expect(host.textContent).not.toContain("No derived summary");
});

it("offers every valid source segment, including brief activity, through a labelled 44px chooser", async () => {
  historyDays.mockResolvedValue({ days: [] });
  const onSeek = vi.fn();
  const base = { app: "Synthetic editor", title: "Synthetic long session", summary: null, category: "dev", distraction_score: 0, source: "rule" };
  const brief = "2026-12-31T00:01:00Z";
  await act(async () => root.render(<RecallDayPanel agentId="a" day="2026-12-31" onDayChange={vi.fn()} timezone="UTC" loading={false} onSeek={onSeek} summary={null}
    segments={[
      { ...base, id: 2, title: "Synthetic brief switch", start_ts: brief, end_ts: "2026-12-31T00:01:05Z" },
      { ...base, id: 1, start_ts: "2026-12-31T00:00:00Z", end_ts: "2026-12-31T00:01:00Z" },
      { ...base, id: 3, title: "Invalid timestamp", start_ts: "invalid", end_ts: brief },
      { ...base, id: 4, title: "Empty interval", start_ts: brief, end_ts: brief },
    ]} />));
  const chooser = [...host.querySelectorAll("select")].find(s => host.querySelector(`label[for="${s.id}"]`)?.textContent?.includes("Open segment source time"))!;
  expect(chooser).toBeDefined();
  expect(Number.parseFloat(getComputedStyle(chooser).minHeight)).toBeGreaterThanOrEqual(44);
  expect(chooser.style.width).toBe("100%"); expect(chooser.style.minWidth).toBe("0");
  expect([...chooser.options].map(o => o.value)).toEqual(["", "1", "2"]);
  expect(chooser.textContent).toContain("5s · Synthetic brief switch");
  expect([...host.querySelectorAll("button")].some(b => b.textContent?.includes("Synthetic brief switch"))).toBe(false);
  act(() => { chooser.value = "2"; chooser.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onSeek).toHaveBeenLastCalledWith(brief);
  const strip = host.querySelector('[data-proportional-timeline]')!;
  expect(strip.getAttribute("role")).toBe("img");
  expect(strip.querySelector("button")).toBeNull();
  const blocks = strip.querySelectorAll<HTMLElement>("span");
  expect(blocks).toHaveLength(2);
  expect(Number(blocks[0].style.flexGrow) / Number(blocks[1].style.flexGrow)).toBe(12);
  expect(historyDays).toHaveBeenCalledTimes(1);
});

it.each([
  ["Asia/Tokyo", "2026-12-31", "2027-01-01", "2026-12-30T15:00:00Z", "2026-12-31T15:00:00Z"],
  ["America/New_York", "2026-03-08", "2026-03-09", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
  ["America/New_York", "2026-11-01", "2026-11-02", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
])("uses exclusive midnight coverage bounds in %s, including DST days", async (timezone, inside, after, from, to) => {
  historyDays.mockResolvedValue({ timezone, from, to, days: [] });
  await render(vi.fn(), "a", inside, timezone);
  const facts = host.querySelector('[aria-label="Selected day retained recordings"]')!;
  expect(facts.textContent).toContain("No retained recordings reported");
  expect(facts.textContent).not.toContain("only part");
  await render(vi.fn(), "a", after, timezone);
  expect(facts.textContent).toContain("outside the returned coverage period");
  expect(facts.textContent).not.toContain("No retained recordings reported");
  expect(historyDays).toHaveBeenCalledTimes(1);
});

it.each([
  ["2026-03-08", "2026-03-09T03:30:00Z", "2026-03-09T04:00:00Z"],
  ["2026-11-01", "2026-11-02T04:30:00Z", "2026-11-02T05:00:00Z"],
])("reports partial observation periods overlapping the final hour of DST day %s", async (day, from, to) => {
  historyDays.mockResolvedValue({ timezone: "America/New_York", from, to, days: [{ ...recording(day, 2), first_ts: from, last_ts: from }] });
  await render(vi.fn(), "a", day, "UTC");
  const facts = host.querySelector('[aria-label="Selected day retained recordings"]')!;
  expect(facts.textContent).toContain("2 retained frames");
  expect(facts.textContent).toContain("observed within the returned coverage period");
  expect(facts.textContent).toContain("only part of this device calendar day");
  expect(facts.textContent).toContain("rest of the day is unverified");
  expect(facts.textContent).not.toContain("outside the returned coverage period");
});
