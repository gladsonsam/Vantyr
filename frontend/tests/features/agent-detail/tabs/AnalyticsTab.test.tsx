// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mountForm, unmountForms } from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { AnalyticsTab } from "@/features/agent-detail/tabs/AnalyticsTab";

const backend = vi.hoisted(() => ({
  agentAnalyticsUrlCategories: vi.fn(),
  agentAnalyticsUrlSites: vi.fn(),
  agentAnalyticsUrlSessions: vi.fn(),
}));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api: backend }));

const categories = [
  { category_key: "work", category_label: "Work", time_ms: 3_600_000, visit_count: 10, last_ts: new Date().toISOString() },
  { category_key: "news", category_label: "News", time_ms: 1_200_000, visit_count: 4, last_ts: new Date().toISOString() },
];
const sites = [
  { hostname: "www.github.com", category_key: "work", category_label: "Work", time_ms: 3_600_000, visit_count: 10, last_ts: new Date().toISOString() },
  { hostname: "bbc.com", category_key: "news", category_label: "News", time_ms: 1_200_000, visit_count: 4, last_ts: new Date().toISOString() },
];

beforeEach(() => {
  backend.agentAnalyticsUrlCategories.mockReset().mockResolvedValue({ rows: categories });
  backend.agentAnalyticsUrlSites.mockReset().mockImplementation(async (_id: string, params: { custom_category_key?: string }) => ({
    rows: params.custom_category_key ? sites.filter((s) => s.category_key === params.custom_category_key) : sites,
  }));
  backend.agentAnalyticsUrlSessions.mockReset().mockResolvedValue({ rows: [] });
});
afterEach(unmountForms);

const text = () => document.body.textContent ?? "";
const legend = (label: string) =>
  Array.from(document.querySelectorAll("button[aria-pressed]")).find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement;

async function mount() {
  await mountForm(withQueryClient(<AnalyticsTab agentId="a1" />));
  await act(async () => {});
}

describe("AnalyticsTab", () => {
  it("summarises the range once: total, visits and each category's share", async () => {
    await mount();
    expect(text()).toContain("1h 20m"); // 3.6M + 1.2M ms → 80 minutes
    expect(text()).toContain("14"); // visits come from the category rows
    expect(text()).toContain("75%");
    expect(text()).toContain("25%");
    expect(text()).toContain("github.com");
    expect(text()).not.toContain("www.github.com");
  });

  it("filters the site list from a category legend entry and lets it be removed", async () => {
    await mount();
    await click(legend("News"));
    await act(async () => {});
    expect(legend("News").getAttribute("aria-pressed")).toBe("true");
    expect(backend.agentAnalyticsUrlSites).toHaveBeenLastCalledWith("a1", expect.objectContaining({ custom_category_key: "news" }));
    expect(text()).toContain("bbc.com");
    expect(text()).not.toContain("github.com");
    await click(document.querySelector('[aria-label="Remove category filter: News"]')!);
    await act(async () => {});
    expect(text()).toContain("github.com");
  });

  it("switches the range and reloads", async () => {
    await mount();
    await click(document.querySelector('[aria-label="Last 24 hours"]')!);
    await act(async () => {});
    expect(backend.agentAnalyticsUrlCategories).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-label="Last 24 hours"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("says so when nothing was browsed", async () => {
    backend.agentAnalyticsUrlCategories.mockResolvedValue({ rows: [] });
    backend.agentAnalyticsUrlSites.mockResolvedValue({ rows: [] });
    await mount();
    expect(text()).toContain("No browsing in this range.");
    expect(text()).not.toContain("Top sites");
  });

  it("offers a retry when loading fails", async () => {
    backend.agentAnalyticsUrlCategories.mockRejectedValueOnce(new Error("boom"));
    await mount();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t load all browsing data.");
    const retry = Array.from(alert!.querySelectorAll("button")).find((b) => b.textContent === "Try again")!;
    await click(retry);
    await act(async () => {});
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
