import { describe, expect, it } from "vitest";
import {
  categoryChartBars,
  humanizeCategoryKey,
  labelToCategoryKey,
  msToHuman,
  stripWww,
  summarizeAnalytics,
  toCategoryOptions,
  toCustomGroups,
} from "./analytics";

describe("humanizeCategoryKey", () => {
  it("title-cases words split on underscores and dashes", () => {
    expect(humanizeCategoryKey("social_networks")).toBe("Social Networks");
    expect(humanizeCategoryKey("  press-and-news ")).toBe("Press And News");
  });
  it("shows a dash for an empty key", () => {
    expect(humanizeCategoryKey("  ")).toBe("—");
  });
});

describe("msToHuman", () => {
  it("formats hours, minutes and seconds", () => {
    expect(msToHuman(3_723_000)).toBe("1h 2m");
    expect(msToHuman(125_000)).toBe("2m 5s");
    expect(msToHuman(120_000)).toBe("2m");
    expect(msToHuman(7_400)).toBe("7s");
  });
  it("clamps negatives to zero", () => {
    expect(msToHuman(-5)).toBe("0s");
  });
});

describe("stripWww", () => {
  it("drops a leading www. in any case and leaves other hosts alone", () => {
    expect(stripWww("WWW.Example.com")).toBe("Example.com");
    expect(stripWww(" example.com ")).toBe("example.com");
    expect(stripWww("")).toBe("");
  });
});

describe("toCategoryOptions", () => {
  it("keeps enabled categories, falls back to a humanized label and sorts by label", () => {
    const options = toCategoryOptions({
      categories: [
        { key: "news", label: "News", enabled: true },
        { key: "social_networks", label: "  ", enabled: true },
        { key: "adult", label: "Adult", enabled: false },
        { key: "banking", enabled: true },
      ],
    });
    expect(options).toEqual([
      { value: "banking", label: "Banking" },
      { value: "news", label: "News" },
      { value: "social_networks", label: "Social Networks" },
    ]);
  });
});

describe("toCustomGroups", () => {
  it("drops hidden groups, sorts by label and tolerates missing UT1 keys", () => {
    const groups = toCustomGroups({
      rows: [
        { id: 2, key: "work", label_en: "Work", hidden: false, ut1_keys: ["news"] },
        { id: 1, key: "fun", label_en: "Fun", hidden: false, ut1_keys: undefined as unknown as string[] },
        { id: 3, key: "old", label_en: "Old", hidden: true, ut1_keys: [] },
      ],
    });
    expect(groups.map((g) => g.key)).toEqual(["fun", "work"]);
    expect(groups[0].ut1_keys).toEqual([]);
  });
});

const categories = [
  { category_key: "news", category_label: "News", time_ms: 90_000 },
  { category_key: "", category_label: "", time_ms: 5_000 },
  { category_key: "social", category_label: " Social ", time_ms: 30_000 },
];

describe("summarizeAnalytics", () => {
  it("totals session time and visits and picks the leading site and category", () => {
    const summary = summarizeAnalytics(
      categories,
      [{ hostname: "www.example.com", time_ms: 61_000, visit_count: 3 }, { hostname: "b.test", time_ms: 1, visit_count: 2 }],
      [{ duration_ms: 1000 }, { duration_ms: 2000 }],
    );
    expect(summary).toEqual({
      totalMs: 3000,
      sessionCount: 5,
      topSite: { hostname: "example.com", timeMs: 61_000 },
      topCategory: { label: "News", timeMs: 90_000 },
    });
  });
  it("has no top entries without rows or names", () => {
    expect(summarizeAnalytics([], [], [])).toEqual({ totalMs: 0, sessionCount: 0, topSite: null, topCategory: null });
    const blank = summarizeAnalytics([{ category_key: "", category_label: "", time_ms: 1 }], [{ hostname: " ", time_ms: 1, visit_count: 1 }], []);
    expect(blank.topSite).toBeNull();
    expect(blank.topCategory).toBeNull();
  });
});

describe("categoryChartBars", () => {
  it("skips unlabelled categories and reports the tallest bar", () => {
    const { bars, max } = categoryChartBars(categories);
    expect(bars).toEqual([{ x: "News", y: 90_000 }, { x: " Social ", y: 30_000 }]);
    expect(max).toBe(90_000);
  });
  it("caps at eight bars and never reports a max below 1", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ category_key: `k${i}`, category_label: `L${i}`, time_ms: 0 }));
    const { bars, max } = categoryChartBars(many);
    expect(bars).toHaveLength(8);
    expect(max).toBe(1);
  });
});

describe("labelToCategoryKey", () => {
  it("maps trimmed labels to keys and ignores incomplete rows", () => {
    const map = labelToCategoryKey(categories);
    expect(map.get("Social")).toBe("social");
    expect(map.size).toBe(2);
  });
});
