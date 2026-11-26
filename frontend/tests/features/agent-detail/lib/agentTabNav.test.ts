import { describe, expect, it } from "bun:test";
import {
  AGENT_SECTION_ORDER,
  AGENT_SECTION_SUBTABS,
  AGENT_TAB_META,
  TAB_KEYS,
  agentSectionFromTabKey,
  agentTabFromParam,
  searchAgentTabs,
} from "@/features/agent-detail/lib/agentTabNav";

describe("agent tool catalog", () => {
  it("places every tab key in exactly one group so none can be stranded", () => {
    const placed = AGENT_SECTION_ORDER.flatMap((section) => AGENT_SECTION_SUBTABS[section]);
    expect([...placed].sort()).toEqual([...TAB_KEYS].sort());
    for (const key of TAB_KEYS)
      expect(AGENT_SECTION_SUBTABS[agentSectionFromTabKey(key)]).toContain(key);
  });

  it("gives each tool a distinct label and a hint for the switcher", () => {
    const labels = TAB_KEYS.map((key) => AGENT_TAB_META[key].label);
    expect(new Set(labels).size).toBe(TAB_KEYS.length);
    for (const key of TAB_KEYS) expect(AGENT_TAB_META[key].hint.length).toBeGreaterThan(0);
  });

  it("keeps old ?tab= links working", () => {
    for (const key of TAB_KEYS) expect(agentTabFromParam(key)).toBe(key);
    expect(agentTabFromParam("screen")).toBe("live");
    expect(agentTabFromParam("nonsense")).toBe("activity");
    expect(agentTabFromParam(null)).toBe("activity");
  });

  it("lists the live desktop with Activity, where it opens on the timeline", () => {
    expect(agentSectionFromTabKey("live")).toBe("activity");
  });

  describe("searchAgentTabs", () => {
    it("returns every tool, in group order, for an empty search", () => {
      expect(searchAgentTabs("  ")).toHaveLength(TAB_KEYS.length);
      expect(searchAgentTabs("")[0]).toBe("live");
    });

    it.each([
      ["logs", "logs"],
      ["log", "logs"],
      ["urls", "urls"],
      ["websites", "urls"],
      ["keystrokes", "keys"],
      ["typing", "keys"],
      ["script", "scripts"],
      ["run", "scripts"],
      ["powershell", "scripts"],
      ["screen", "live"],
      ["block", "control"],
      ["ram", "specs"],
      ["uninstall", "software"],
      ["delete", "settings"],
    ] as const)("puts the obvious tool first for %s", (query, expected) => {
      expect(searchAgentTabs(query)[0]).toBe(expected);
    });

    it("needs every word to match and ignores letter-soup matches", () => {
      expect(searchAgentTabs("device logs")).toEqual(["logs"]);
      expect(searchAgentTabs("zzz")).toEqual([]);
      expect(searchAgentTabs("lgs")).toEqual([]);
    });

    it("matches a group name to its tools", () => {
      expect(searchAgentTabs("monitoring").slice(0, 4).sort()).toEqual([
        "alerts",
        "keys",
        "urls",
        "windows",
      ]);
    });
  });
});
