import { describe, expect, it } from "vitest";
import { filterLog, logCountLabel, logLines } from "@/features/agent-detail/lib/logView";

describe("logView", () => {
  it("counts lines without the one the final newline ends", () => {
    expect(logLines("")).toEqual([]);
    expect(logLines("a\nb\n")).toEqual(["a", "b"]);
    expect(logLines("a\r\nb")).toEqual(["a", "b"]);
  });

  it("keeps every line for a blank filter and the matching ones otherwise, in any letter case", () => {
    const text = "10:00 INFO ok\n10:01 ERROR boom\n10:02 info fine\n";
    expect(filterLog(text, "  ")).toEqual({ text, shown: 3, total: 3 });
    expect(filterLog(text, "error")).toEqual({ text: "10:01 ERROR boom", shown: 1, total: 3 });
    expect(filterLog(text, "INFO").shown).toBe(2);
    expect(filterLog(text, "zzz")).toEqual({ text: "", shown: 0, total: 3 });
  });

  it("words the count, saying how many of the total matched", () => {
    expect(logCountLabel({ text: "", shown: 1204, total: 1204 })).toBe("1,204 lines");
    expect(logCountLabel({ text: "", shown: 1, total: 1 })).toBe("1 line");
    expect(logCountLabel({ text: "", shown: 12, total: 1204 })).toBe("12 of 1,204 lines");
  });
});
