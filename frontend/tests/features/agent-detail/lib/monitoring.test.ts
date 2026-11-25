import { describe, expect, it } from "vitest";
import { categoryOf, isLongText, listCountLabel, sharedValue, splitUrl, titleRestatesApp } from "@/features/agent-detail/lib/monitoring";

describe("splitUrl", () => {
  it("separates the domain from the page and keeps a usable href", () => {
    expect(splitUrl("https://www.example.test/a/b?x=1#top")).toEqual({
      host: "example.test",
      rest: "/a/b?x=1#top",
      href: "https://www.example.test/a/b?x=1#top",
    });
  });

  it("treats a bare domain as having no path and assumes https", () => {
    expect(splitUrl("example.org")).toEqual({ host: "example.org", rest: "", href: "https://example.org" });
    expect(splitUrl("https://example.org/")).toMatchObject({ host: "example.org", rest: "" });
  });

  it("keeps the port and survives things that are not URLs", () => {
    expect(splitUrl("http://localhost:3000/x").host).toBe("localhost:3000");
    expect(splitUrl("   ")).toEqual({ host: "", rest: "", href: "#" });
    expect(splitUrl("http://[bad").host).not.toBe("");
  });
});

describe("categoryOf", () => {
  it("treats the server's 'Uncategorized' as no category", () => {
    expect(categoryOf("Uncategorized")).toBeUndefined();
    expect(categoryOf(" uncategorized ")).toBeUndefined();
    expect(categoryOf("")).toBeUndefined();
    expect(categoryOf(null)).toBeUndefined();
    expect(categoryOf("News")).toBe("News");
  });
});

describe("listCountLabel", () => {
  const noun = { one: "visit", many: "visits" };
  it("states a plain total while the list is not capped", () => {
    expect(listCountLabel({ shown: 12, loaded: 12, limit: 500, noun })).toBe("12 visits");
    expect(listCountLabel({ shown: 1, loaded: 1, limit: 500, noun })).toBe("1 visit");
  });

  it("never claims a total once the page limit is reached", () => {
    expect(listCountLabel({ shown: 500, loaded: 500, limit: 500, noun })).toBe("500 most recent visits");
  });

  it("says how many of the loaded rows a search keeps", () => {
    expect(listCountLabel({ shown: 3, loaded: 500, limit: 500, noun })).toBe("3 of 500 most recent visits");
    expect(listCountLabel({ shown: 0, loaded: 40, limit: 500, noun })).toBe("0 of 40 visits");
  });
});

describe("titleRestatesApp", () => {
  it("hides window titles that only repeat the application", () => {
    expect(titleRestatesApp("Notepad", "Notepad", "notepad.exe")).toBe(true);
    expect(titleRestatesApp("notepad", null, "Notepad.exe")).toBe(true);
    expect(titleRestatesApp("—", "Notepad")).toBe(true);
    expect(titleRestatesApp("", "Notepad")).toBe(true);
  });

  it("keeps titles that say something", () => {
    expect(titleRestatesApp("Untitled - Notepad", "Notepad", "notepad.exe")).toBe(false);
  });
});

describe("isLongText / sharedValue", () => {
  it("folds long or many-line text only", () => {
    expect(isLongText("short")).toBe(false);
    expect(isLongText("x".repeat(181))).toBe(true);
    expect(isLongText("a\nb\nc\nd")).toBe(true);
    expect(isLongText("a\nb\nc")).toBe(false);
  });

  it("reports the one value every entry agrees on", () => {
    expect(sharedValue(["Chrome", "Chrome"])).toBe("Chrome");
    expect(sharedValue(["Chrome", "Edge"])).toBe("");
    expect(sharedValue([])).toBe("");
  });
});
