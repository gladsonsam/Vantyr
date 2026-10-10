import { describe, expect, it } from "vitest";
import {
  ASSIGN_CATEGORY_DEFAULTS,
  assignCategorySchema,
  defaultCategoryKey,
  specificCategoryOptions,
  toOverrideBody,
} from "@/features/agent-detail/lib/assignCategoryForm";

const groups = [
  { id: 1, key: "work", label: "Work", hidden: false, ut1_keys: ["news", "forums"] },
  { id: 2, key: "empty", label: "Empty", hidden: false, ut1_keys: [] },
];
const options = [
  { value: "news", label: "News" },
  { value: "forums", label: "Forums" },
  { value: "games", label: "Games" },
];

describe("assignCategorySchema", () => {
  it("needs an underlying category key", () => {
    expect(assignCategorySchema.safeParse(ASSIGN_CATEGORY_DEFAULTS).success).toBe(false);
    expect(assignCategorySchema.safeParse({ ...ASSIGN_CATEGORY_DEFAULTS, categoryKey: "news" }).success).toBe(true);
  });
});

describe("toOverrideBody", () => {
  const target = { kind: "domain" as const, value: "example.com", hostname: "example.com", url: null };
  it("sends the trimmed note, or none when blank", () => {
    expect(toOverrideBody(target, { ...ASSIGN_CATEGORY_DEFAULTS, categoryKey: "news", note: "  why  " })).toEqual({
      kind: "domain", value: "example.com", category_key: "news", note: "why",
    });
    expect(toOverrideBody(target, { ...ASSIGN_CATEGORY_DEFAULTS, categoryKey: "news", note: "  " }).note).toBeUndefined();
  });
});

describe("defaultCategoryKey", () => {
  it("starts from the custom category's first UT1 key", () => {
    expect(defaultCategoryKey("work", groups)).toBe("news");
  });
  it("is empty without a custom category or UT1 keys", () => {
    expect(defaultCategoryKey("", groups)).toBe("");
    expect(defaultCategoryKey("empty", groups)).toBe("");
    expect(defaultCategoryKey("missing", groups)).toBe("");
  });
});

describe("specificCategoryOptions", () => {
  it("limits UT1 options to the custom category's keys", () => {
    expect(specificCategoryOptions("work", groups, options).map((o) => o.value)).toEqual(["news", "forums"]);
  });
  it("offers every option without a (known) custom category", () => {
    expect(specificCategoryOptions("", groups, options)).toBe(options);
    expect(specificCategoryOptions("missing", groups, options)).toBe(options);
  });
});
