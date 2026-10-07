import { describe, expect, it } from "vitest";
import { sourceUrlSchema, urlOverrideSchema } from "./urlCategorizationSchemas";

describe("sourceUrlSchema", () => {
  it("requires a source URL and trims it", () => {
    const blank = sourceUrlSchema.safeParse({ source_url: "   " });
    expect(blank.error?.issues).toMatchObject([{ path: ["source_url"], message: "source_url is required" }]);
    expect(sourceUrlSchema.parse({ source_url: " https://x/list.tar.gz " }).source_url).toBe("https://x/list.tar.gz");
  });
});

describe("urlOverrideSchema", () => {
  const ok = { kind: "domain" as const, value: "example.com", category_key: "games", note: "" };

  it("accepts a filled override and sends the value as typed", () => {
    expect(urlOverrideSchema.safeParse(ok).success).toBe(true);
    expect(urlOverrideSchema.parse({ ...ok, value: " example.com " }).value).toBe(" example.com ");
  });

  it("needs a value and a category", () => {
    expect(urlOverrideSchema.safeParse({ ...ok, value: "  " }).success).toBe(false);
    expect(urlOverrideSchema.safeParse({ ...ok, category_key: "" }).success).toBe(false);
  });
});
