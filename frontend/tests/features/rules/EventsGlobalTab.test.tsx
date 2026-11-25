// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click } from "@tests/support/formDom";
import { EventsGlobalTab } from "@/features/rules/EventsGlobalTab";

const api = vi.hoisted(() => ({
  alertRuleEventsAll: vi.fn(),
  appBlockEventsAll: vi.fn(),
  scheduledScriptEventsAll: vi.fn(),
  agentSessionsAll: vi.fn(),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e), apiUrl: (p: string) => p }));

const alertRow = (id: number, patch: Record<string, unknown> = {}) => ({
  id, agent_id: "a1", agent_name: "Alpha", rule_name: "Social media", channel: "url", snippet: "facebook.com/profile",
  has_screenshot: false, screenshot_requested: false, created_at: `2026-11-01T10:0${id}:00Z`, ...patch,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.alertRuleEventsAll.mockResolvedValue({ rows: [alertRow(1, { has_screenshot: true, screenshot_requested: true }), alertRow(2, { screenshot_requested: true })] });
  api.appBlockEventsAll.mockResolvedValue({ rows: [{ id: 3, agent_id: "a2", agent_name: "Bravo", rule_name: null, exe_name: "steam.exe", killed_at: "2026-11-01T10:05:00Z" }] });
  api.scheduledScriptEventsAll.mockResolvedValue({
    rows: [{ script_id: 4, agent_id: "a1", agent_name: "Alpha", rule_name: "Disk report", is_manual: true, status: "failed", output: "line one\nline two", expected_fire_time: "2026-11-01T10:06:00Z" }],
  });
  api.agentSessionsAll.mockResolvedValue({ rows: [{ id: 5, agent_id: "a2", agent_name: "Bravo", connected_at: "2026-11-01T09:00:00Z", disconnected_at: "2026-11-01T09:30:00Z" }] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(withQueryClient(<MemoryRouter><EventsGlobalTab /></MemoryRouter>, createTestQueryClient())));
}
const items = () => [...host.querySelectorAll('ul[aria-label="Events, newest first"] > li')];
const tab = (label: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.startsWith(label))!;

describe("EventsGlobalTab", () => {
  it("merges every feed newest first, each row naming its kind, agent, time and what happened", async () => {
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("6 events");
    const rows = items();
    expect(rows).toHaveLength(6);
    expect(rows[0].textContent).toContain("Script");
    expect(rows[0].textContent).toContain("Disk report (run manually)");
    expect(rows[0].textContent).toContain("failed");
    expect(rows[1].textContent).toContain("App block");
    expect(rows[1].textContent).toContain("steam.exe");
    expect(rows[1].textContent).toContain("Bravo");
    expect(rows[rows.length - 2].textContent).toContain("Went offline");
    expect(rows[rows.length - 1].textContent).toContain("Came online");
  });

  it("keeps the activity deep link, the screenshot and the no-screenshot evidence", async () => {
    await render();
    const alerts = items().filter((r) => r.textContent?.includes("Social media"));
    expect(alerts).toHaveLength(2);
    // Newest first: the second alert (no screenshot captured although requested) comes first.
    expect(alerts[0].textContent).toContain("No screenshot");
    expect(alerts[1].querySelector('button[aria-label^="View screenshot"]')).not.toBeNull();
    expect(alerts[1].querySelector("a")?.getAttribute("href")).toBe("/agents/a1?tab=activity&at=2026-11-01T10%3A01%3A00Z");
    expect(alerts[0].textContent).not.toContain("View screenshot");
  });

  it("filters by kind with counts and a matching empty message", async () => {
    api.scheduledScriptEventsAll.mockResolvedValue({ rows: [] });
    await render();
    expect(tab("Alerts").textContent).toBe("Alerts2");
    expect(tab("Scripts").textContent).toBe("Scripts0");
    await click(tab("Alerts"));
    expect(items()).toHaveLength(2);
    await click(tab("Scripts"));
    expect(host.textContent).toContain("No scripts yet");
    expect(host.textContent).toContain("No scheduled script has run yet.");
  });

  it("shows long script output in two lines with the rest one click away", async () => {
    await render();
    const script = items()[0];
    const toggle = [...script.querySelectorAll("button")].find((b) => b.textContent === "Show more")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.textContent).toBe("Show less");
    expect(script.textContent).toContain("line two");
  });

  it("says which feeds failed and that the list is incomplete, rather than quietly omitting them", async () => {
    api.scheduledScriptEventsAll.mockRejectedValueOnce(new Error("500")).mockResolvedValue({ rows: [] });
    await render();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t load scripts.");
    expect(alert?.textContent).toContain("this list is incomplete");
    expect(tab("Scripts").textContent).toBe("Scripts?");
    expect(items().length).toBeGreaterThan(0);
    await click([...alert!.querySelectorAll("button")].find((b) => b.textContent === "Try again")!);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not claim there are no events when every feed failed", async () => {
    for (const f of [api.alertRuleEventsAll, api.appBlockEventsAll, api.scheduledScriptEventsAll, api.agentSessionsAll]) f.mockRejectedValue(new Error("down"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("No events are shown.");
    expect(host.textContent).not.toContain("No events yet");
  });

  it("says when each feed was cut at its newest rows", async () => {
    api.alertRuleEventsAll.mockResolvedValue({ rows: Array.from({ length: 500 }, (_, i) => alertRow(i + 1, { created_at: "2026-11-01T10:00:00Z" })) });
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("newest 500 of each kind");
    expect(tab("Alerts").textContent).toBe("Alerts500+");
  });
});
