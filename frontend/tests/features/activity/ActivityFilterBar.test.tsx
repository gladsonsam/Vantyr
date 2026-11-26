import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import { buttonByText, click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { ActivityFilterBar } from "@/features/activity/ActivityFilterBar";
import { absoluteRangeForPresetDays } from "@/features/activity/activityDateRange";
import type { ActivityFilters } from "@/features/activity/useActivityFilters";

afterEach(unmountForms);

function makeFilters(overrides: Partial<ActivityFilters> = {}): ActivityFilters {
  return {
    searchQuery: "",
    alertsOnly: false,
    appFilterExe: null,
    jumpRangeValue: null,
    isFiltered: false,
    setSearchQuery: vi.fn(),
    setAlertsOnly: vi.fn(),
    setAppFilterExe: vi.fn(),
    setJumpRangeValue: vi.fn(),
    toggleAppFilter: vi.fn(),
    clearFilters: vi.fn(),
    deepLinkToActivity: vi.fn(),
    ...overrides,
  } as ActivityFilters;
}

const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

async function mountBar(filters: ActivityFilters, onJumpRangeChange = vi.fn()) {
  await mountForm(
    <ActivityFilterBar
      filters={filters}
      summary="3 of 9 sessions"
      loading={false}
      onRefresh={vi.fn()}
      onJumpRangeChange={onJumpRangeChange}
    />,
  );
  return onJumpRangeChange;
}

describe("ActivityFilterBar", () => {
  it("shows no chip row while nothing is filtered", async () => {
    await mountBar(makeFilters());
    expect(document.body.textContent).not.toContain("Clear all");
    expect(byLabel("Alerts only")?.getAttribute("aria-pressed")).toBe("false");
    expect(byLabel("Dates: All days")).not.toBeNull();
  });

  it("names every active filter as a removable chip with the match count and a reset", async () => {
    const range = absoluteRangeForPresetDays(7);
    const filters = makeFilters({
      isFiltered: true,
      alertsOnly: true,
      appFilterExe: "chrome.exe",
      searchQuery: " bank ",
      jumpRangeValue: { type: "absolute", startDate: range.start, endDate: range.end },
    });
    await mountBar(filters);
    expect(byLabel("Dates: Last 7 days")).not.toBeNull();
    expect(document.body.textContent).toContain("3 of 9 sessions");

    await click(byLabel("Remove alerts filter: Alerts only")!);
    expect(filters.setAlertsOnly).toHaveBeenCalledWith(false);
    await click(byLabel("Remove app filter: chrome.exe")!);
    expect(filters.setAppFilterExe).toHaveBeenCalledWith(null);
    await click(byLabel("Clear search: “bank”")!);
    expect(filters.setSearchQuery).toHaveBeenCalledWith("");
    await click(buttonByText("Clear all"));
    expect(filters.clearFilters).toHaveBeenCalled();
  });

  it("toggles alerts-only and passes typed search text through", async () => {
    const filters = makeFilters();
    await mountBar(filters);
    await click(byLabel("Alerts only")!);
    expect(filters.setAlertsOnly).toHaveBeenCalledWith(true);
    await typeInto(document.getElementById("activity-search") as HTMLInputElement, "invoice");
    expect(filters.setSearchQuery).toHaveBeenCalledWith("invoice");
  });

  it("picks a date preset from the dates popover and clears it again", async () => {
    const filters = makeFilters();
    const onJumpRangeChange = await mountBar(filters);
    await click(byLabel("Dates: All days")!);
    await click(buttonByText("Last 7 days"));
    const expected = absoluteRangeForPresetDays(7);
    expect(onJumpRangeChange).toHaveBeenCalledWith({
      type: "absolute",
      startDate: expected.start,
      endDate: expected.end,
    });
  });
});
