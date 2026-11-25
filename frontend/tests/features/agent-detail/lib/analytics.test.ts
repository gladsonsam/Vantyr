import { describe, expect, it } from "vitest";
import {
  humanizeCategoryKey,
  categorySlices,
  formatShare,
  msToHuman,
  stripWww,
  summarizeAnalytics,
  toCategoryOptions,
  totalVisits,
  toCustomGroups,
} from "@/features/agent-detail/lib/analytics";

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
  it("totals time and visits and picks the leading site", () => {
    const summary = summarizeAnalytics(
      categories,
      [{ hostname: "www.example.com", time_ms: 61_000, visit_count: 3 }, { hostname: "b.test", time_ms: 1, visit_count: 2 }],
      [{ duration_ms: 1000 }, { duration_ms: 2000 }],
    );
    // Categories add up to more than the session feed, so the total follows them.
    expect(summary).toEqual({
      totalMs: 125_000,
      visitCount: 5,
      topSite: { hostname: "example.com", timeMs: 61_000 },
    });
  });
  it("has no top entries without rows or names", () => {
    expect(summarizeAnalytics([], [], [])).toEqual({ totalMs: 0, visitCount: 0, topSite: null });
    const blank = summarizeAnalytics([{ category_key: "", category_label: "", time_ms: 1 }], [{ hostname: " ", time_ms: 1, visit_count: 1 }], []);
    expect(blank.topSite).toBeNull();
  });
});

describe("totalVisits", () => {
  it("uses category counts when they cover more visits than the capped site list", () => {
    const cats = [
      { category_key: "a", category_label: "A", time_ms: 1, visit_count: 984 },
      { category_key: "", category_label: "B", time_ms: 1, visit_count: 6 },
    ];
    expect(totalVisits(cats, [{ hostname: "x", time_ms: 1, visit_count: 975 }])).toBe(990);
  });
  it("does not undercount known site visits when category rows are also capped", () => {
    expect(totalVisits(
      [{ category_key: "a", category_label: "A", time_ms: 1, visit_count: 3 }],
      [{ hostname: "x", time_ms: 1, visit_count: 8 }],
    )).toBe(8);
  });
  it("falls back to the site rows when categories carry no counts", () => {
    expect(totalVisits([{ category_key: "a", category_label: "A", time_ms: 1 }], [{ hostname: "x", time_ms: 1, visit_count: 4 }])).toBe(4);
    expect(totalVisits([], [])).toBe(0);
  });
});

describe("categorySlices", () => {
  const cats = [
    { category_key: "b", category_label: "B", time_ms: 300, visit_count: 3 },
    { category_key: "a", category_label: "A", time_ms: 600, visit_count: 6 },
    { category_key: "z", category_label: "Z", time_ms: 0 },
  ];
  it("orders largest first, drops empty categories and shares the total", () => {
    const { slices, otherMs } = categorySlices(cats, 900);
    expect(slices.map((s) => s.key)).toEqual(["a", "b"]);
    expect(slices[0].share).toBeCloseTo(2 / 3);
    expect(otherMs).toBe(0);
  });
  it("reports time the categories do not account for instead of inflating shares", () => {
    const { slices, otherMs } = categorySlices(cats, 1_800);
    expect(slices[0].share).toBeCloseTo(1 / 3);
    expect(otherMs).toBe(900);
  });
  it("is empty without time", () => {
    expect(categorySlices([], 0)).toEqual({ slices: [], otherMs: 0 });
  });
});

describe("formatShare", () => {
  it("rounds, and never shows a real sliver as zero", () => {
    expect(formatShare(0.4237)).toBe("42%");
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
  });
});
