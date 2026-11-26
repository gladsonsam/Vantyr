import { describe, expect, it } from "bun:test";
import type { Agent, AgentGroup, AlertRule } from "@/api/types";
import {
  cooldownLabel,
  fmtSeconds,
  ruleCountSummary,
  ruleMatchSummary,
  ruleTitle,
  scopeLabels,
} from "@/features/rules/lib/alertRuleSummary";

const rule = (patch: Partial<AlertRule>): AlertRule => ({
  id: 1,
  name: "",
  channel: "url",
  pattern: "youtube.com",
  match_mode: "substring",
  case_insensitive: true,
  cooldown_secs: 300,
  enabled: true,
  take_screenshot: false,
  scopes: [{ kind: "all" }],
  ...patch,
});
const groups = [
  { id: "g1", name: "Lab" },
  { id: "g2", name: "Kiosks" },
] as AgentGroup[];
const agents = { a1: { id: "a1", name: "Alpha" } } as unknown as Record<string, Agent>;

describe("ruleMatchSummary and ruleTitle", () => {
  it("describes monitoring rules by their condition and pattern rules by their pattern", () => {
    expect(
      ruleMatchSummary(
        rule({ channel: "resource", metric: "mem_pct", comparator: "lt", threshold: 20 }),
      ),
    ).toBe("Memory < 20%");
    expect(ruleMatchSummary(rule({ channel: "agent_offline", duration_secs: 600 }))).toBe(
      "Offline ≥ 10 min",
    );
    expect(ruleMatchSummary(rule({}))).toBe("youtube.com");
  });

  it("lists an unnamed rule under what it matches", () => {
    expect(ruleTitle(rule({ name: "  Video  " }))).toBe("Video");
    expect(ruleTitle(rule({ name: " " }))).toBe("youtube.com");
    expect(
      ruleTitle(
        rule({ name: "", channel: "resource", pattern: "", metric: "cpu_pct", threshold: 90 }),
      ),
    ).toBe("CPU > 90%");
  });
});

describe("scopeLabels", () => {
  it("names every distinct place, not only the first scope", () => {
    expect(
      scopeLabels(
        [
          { kind: "group", group_id: "g1" },
          { kind: "agent", agent_id: "a1" },
          { kind: "group", group_id: "g1" },
          { kind: "group", group_id: "g2" },
        ],
        groups,
        agents,
      ),
    ).toEqual(["Group · Lab", "Agent · Alpha", "Group · Kiosks"]);
  });

  it("collapses to All devices when the rule covers everyone, and says when there is no scope", () => {
    expect(
      scopeLabels([{ kind: "group", group_id: "g1" }, { kind: "all" }], groups, agents),
    ).toEqual(["All devices"]);
    expect(scopeLabels([], groups, agents)).toEqual(["No scope"]);
  });

  it("does not show raw ids for groups or agents it cannot name", () => {
    expect(
      scopeLabels(
        [
          { kind: "group", group_id: "gone" },
          { kind: "agent", agent_id: "9f2c" },
        ],
        groups,
        agents,
      ),
    ).toEqual(["Group · unknown", "Agent · unknown"]);
  });
});

describe("durations and counts", () => {
  it("uses the largest whole unit", () => {
    expect(["30", "60", "300", "90", "3600", "7200"].map((n) => fmtSeconds(Number(n)))).toEqual([
      "30 s",
      "1 min",
      "5 min",
      "90 s",
      "1 h",
      "2 h",
    ]);
    expect(cooldownLabel(0)).toBe("Fires on every match");
    expect(cooldownLabel(900)).toBe("At most once per 15 min per agent");
  });

  it("summarises how many rules are on", () => {
    expect(ruleCountSummary([rule({}), rule({ id: 2 })])).toBe("2 rules · all on");
    expect(ruleCountSummary([rule({}), rule({ id: 2, enabled: false })])).toBe("2 rules · 1 on");
    expect(ruleCountSummary([rule({})])).toBe("1 rule · all on");
  });
});
