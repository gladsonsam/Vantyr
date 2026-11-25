// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { UrlsTab } from "@/features/agent-detail/tabs/UrlsTab";
import { KeysTab } from "@/features/agent-detail/tabs/KeysTab";
import { WindowsTab } from "@/features/agent-detail/tabs/WindowsTab";
import { EventsTab } from "@/features/activity/EventsTab";

const backend = vi.hoisted(() => ({
  urls: vi.fn(),
  keys: vi.fn(),
  windows: vi.fn(),
  topWindows: vi.fn(),
  agentAlertRuleEvents: vi.fn(),
  appBlockEventsForAgent: vi.fn(),
  agentEffectiveRules: vi.fn(),
  agentUrlCategoryBackfill: vi.fn(),
}));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api: backend }));

const TRACKED = "https://www.shop.test/chairs/sale?utm_source=ads&gclid=abc123";
const url = (id: number, over: Record<string, unknown> = {}) => ({
  id, url: "https://example.org/", title: null, browser: "Chrome", ts: `2026-01-02T10:0${id}:00Z`, user: "kid", category_key: null, category: "Uncategorized", ...over,
});

beforeEach(() => {
  backend.urls.mockReset().mockResolvedValue({ rows: [url(1), url(2, { url: TRACKED, title: "Chairs on sale", category: "Shopping" }), url(3, { browser: "Edge" })] });
  backend.keys.mockReset().mockResolvedValue({
    rows: [
      { app: "notepad.exe", app_display: "Notepad", window_title: "Notepad", text: "hello", started_at: "2026-01-02T10:00:00Z", updated_at: "2026-01-02T10:01:00Z", user: "kid" },
      { app: "winword.exe", app_display: "Word", window_title: "Essay.docx - Word", text: "w".repeat(400), started_at: "2026-01-02T10:05:00Z", updated_at: "2026-01-02T10:06:00Z", user: "kid" },
    ],
  });
  backend.windows.mockReset().mockResolvedValue({
    rows: [
      { app: "notepad.exe", app_display: "Notepad", title: "Notepad", hwnd: 1, ts: "2026-01-02T10:00:00Z", user: "kid" },
      { app: "chrome.exe", app_display: "Chrome", title: "Inbox - Mail", hwnd: 2, ts: "2026-01-02T10:05:00Z", user: "kid" },
    ],
  });
  backend.topWindows.mockReset().mockResolvedValue({ rows: [{ app: "chrome.exe", app_display: "Chrome", title: "Inbox - Mail", focus_count: 9, last_ts: "2026-01-02T10:05:00Z" }] });
  backend.agentAlertRuleEvents.mockReset().mockResolvedValue({
    rows: [
      { id: 1, rule_id: 5, rule_name: "Gambling", channel: "url", snippet: "casino.test", has_screenshot: true, screenshot_requested: true, created_at: "2026-01-02T10:00:00Z" },
      { id: 2, rule_id: 6, rule_name: "Keywords", channel: "keys", snippet: "secret", has_screenshot: false, screenshot_requested: true, created_at: "2026-01-02T09:00:00Z" },
      { id: 3, rule_id: 7, rule_name: "Offline", channel: "agent_offline", snippet: "", has_screenshot: false, screenshot_requested: false, created_at: "2026-01-02T08:00:00Z" },
    ],
  });
  backend.appBlockEventsForAgent.mockReset().mockResolvedValue({ rows: [{ id: 1, agent_id: "a1", agent_name: "PC", rule_id: 1, rule_name: "No games", exe_name: "steam.exe", killed_at: "2026-01-02T10:00:00Z" }] });
  backend.agentEffectiveRules.mockReset().mockResolvedValue({
    alert_rules: [{ id: 5, name: "Gambling", pattern: "casino", scope_kind: "all" }],
    app_block_rules: [],
    internet_blocked: true,
    internet_block_source: "group",
  });
});
afterEach(unmountForms);

const text = () => document.body.textContent ?? "";
const settle = () => act(async () => {});
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement;

async function mount(node: React.ReactNode) {
  await mountForm(withQueryClient(<MemoryRouter>{node}</MemoryRouter>));
  await settle();
  await settle();
}

describe("UrlsTab", () => {
  it("shows the domain, the page title and the shortened rest, with the full URL one click away", async () => {
    await mount(<UrlsTab agentId="a1" dashboardRole="viewer" />);
    expect(text()).toContain("shop.test");
    expect(text()).not.toContain("www.shop.test");
    expect(text()).toContain("Chairs on sale");
    const link = Array.from(document.querySelectorAll("a")).find((a) => a.textContent === "shop.test")!;
    expect(link.getAttribute("href")).toBe(TRACKED);
    expect(link.getAttribute("title")).toBe(TRACKED);
    expect(document.querySelectorAll('[aria-label="Copy full URL"]').length).toBe(3);
  });

  it("counts honestly and does not repeat 'Uncategorized' on every row", async () => {
    await mount(<UrlsTab agentId="a1" dashboardRole="viewer" />);
    expect(text()).toContain("3 visits");
    expect(text()).not.toContain("Uncategorized");
    expect(text()).toContain("Shopping");
  });

  it("filters by search, says how many matched, and clears", async () => {
    await mount(<UrlsTab agentId="a1" dashboardRole="viewer" />);
    await typeInto(document.querySelector('input[aria-label="Search URLs"]') as HTMLInputElement, "chairs");
    expect(text()).toContain("1 of 3 visits");
    expect(text()).not.toContain("example.org");
    await click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Clear search")!);
    expect(text()).toContain("3 visits");
  });

  it("offers history categorisation to admins only", async () => {
    await mount(<UrlsTab agentId="a1" dashboardRole="viewer" />);
    expect(byLabel("More URL actions")).toBeNull();
    unmountForms();
    await mount(<UrlsTab agentId="a1" dashboardRole="admin" />);
    expect(byLabel("More URL actions")).not.toBeNull();
  });

  it("reports a failed load instead of an empty list, and retries", async () => {
    backend.urls.mockRejectedValueOnce(new Error("boom"));
    await mount(<UrlsTab agentId="a1" dashboardRole="viewer" />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load website visits");
    await click(Array.from(document.querySelectorAll('[role="alert"] button')).find((b) => b.textContent === "Try again")!);
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("3 visits");
  });
});

describe("KeysTab", () => {
  it("folds long typed text behind an accessible toggle and leaves short text alone", async () => {
    await mount(<KeysTab agentId="a1" />);
    expect(text()).toContain("hello");
    const toggle = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Show all"))!;
    expect(toggle.textContent).toBe("Show all 400 characters");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show less");
  });

  it("drops a window title that only repeats the app, keeps one that adds information", async () => {
    await mount(<KeysTab agentId="a1" />);
    const cells = Array.from(document.querySelectorAll("tbody td")).map((td) => td.textContent);
    expect(cells.filter((c) => c === "Notepad")).toHaveLength(1); // app label only
    expect(text()).toContain("Essay.docx - Word");
  });

  it("filters to one app from its name and counts typing sessions", async () => {
    await mount(<KeysTab agentId="a1" />);
    expect(text()).toContain("2 typing sessions");
    await click(Array.from(document.querySelectorAll("tbody button")).find((b) => b.getAttribute("title") === "Only show winword.exe")!);
    expect(text()).toContain("1 of 2 typing sessions");
  });
});

describe("WindowsTab", () => {
  it("lists focus changes with the most-focused windows as filters", async () => {
    await mount(<WindowsTab agentId="a1" />);
    expect(text()).toContain("2 focus changes");
    const chip = document.querySelector("button[aria-pressed]") as HTMLButtonElement;
    expect(chip.textContent).toContain("Inbox - Mail");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    await click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("1 of 2 focus changes");
    await click(chip);
    expect(text()).toContain("2 focus changes");
  });

  it("keeps timeline and Recall reachable per row with accessible names", async () => {
    await mount(<WindowsTab agentId="a1" />);
    expect(document.querySelectorAll('[aria-label="Show in timeline"]').length).toBe(2);
    expect(document.querySelectorAll('[aria-label="Open in Recall"]').length).toBe(2);
  });
});

describe("EventsTab", () => {
  it("shows alerts first with rule, channel and evidence actions, and counts in the tab names", async () => {
    const onTimeline = vi.fn();
    await mount(<EventsTab agentId="a1" onViewTimeline={onTimeline} />);
    expect(text()).toContain("Alerts3");
    expect(text()).toContain("Blocked apps1");
    expect(text()).toContain("Gambling");
    expect(byLabel("View screenshot for Gambling")).not.toBeNull();
    expect(text()).toContain("No screenshot"); // requested but not captured
    expect(document.querySelectorAll("tbody td").length).toBeGreaterThan(0);
    await click(document.querySelectorAll('[aria-label="Show in timeline"]')[0]);
    expect(onTimeline).toHaveBeenCalledWith("2026-01-02T10:00:00Z");
  });

  it("searches alerts by the channel's label", async () => {
    await mount(<EventsTab agentId="a1" />);
    await typeInto(document.querySelector('input[aria-label="Filter alert events"]') as HTMLInputElement, "keystrokes");
    expect(text()).toContain("1 of 3 alerts");
  });

  it("keeps the rules summary on one line and folded, with the internet state stated", async () => {
    await mount(<EventsTab agentId="a1" />);
    const summary = document.querySelector("summary")!;
    expect(summary.textContent).toContain("1 alert rule · 0 app blocks · Internet blocked");
    expect(summary.closest("details")!.open).toBe(false);
  });

  it("flags a failed alert load rather than claiming nothing fired", async () => {
    backend.agentAlertRuleEvents.mockRejectedValue(new Error("down"));
    await mount(<EventsTab agentId="a1" />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load alert events");
  });
});
