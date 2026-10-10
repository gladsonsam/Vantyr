import { describe, expect, it } from "vitest";
import { DRIVES_PATH, baseName, breadcrumbs, formatFileSize, joinPath } from "@/features/files/filePaths";

describe("joinPath", () => {
  it("joins with a single backslash", () => {
    expect(joinPath("C:\\Users", "a.txt")).toBe("C:\\Users\\a.txt");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
  });

  it("returns the name alone for an empty base", () => {
    expect(joinPath("", "C:\\")).toBe("C:\\");
  });
});

describe("baseName", () => {
  it("returns the last path segment", () => {
    expect(baseName("C:\\Users\\demo\\notes.txt")).toBe("notes.txt");
    expect(baseName("C:\\Users\\demo\\")).toBe("demo");
    expect(baseName("")).toBe("");
  });
});

describe("breadcrumbs", () => {
  it("is just Root for the drive list or no path", () => {
    expect(breadcrumbs("")).toEqual([{ text: "Root", path: DRIVES_PATH }]);
    expect(breadcrumbs(DRIVES_PATH)).toEqual([{ text: "Root", path: DRIVES_PATH }]);
  });

  it("builds cumulative paths for each segment", () => {
    expect(breadcrumbs("C:\\Users\\demo")).toEqual([
      { text: "Root", path: DRIVES_PATH },
      { text: "C:", path: "C:\\" },
      { text: "Users", path: "C:\\Users\\" },
      { text: "demo", path: "C:\\Users\\demo\\" },
    ]);
  });
});

describe("formatFileSize", () => {
  it("formats bytes with binary units", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3 MB");
  });
});
