import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecallDayPicker } from "./RecallDayPicker";
import { RecallDayPanel } from "./RecallDayPanel";
import type { HistoryDay } from "../../lib/types";
const { historyDays } = vi.hoisted(() => ({ historyDays: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { historyDays } }));
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
