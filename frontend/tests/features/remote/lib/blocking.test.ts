import { describe, expect, it } from "vitest";
import type { AppBlockRule } from "@/api/types";
import { blockSourceLabel, capabilityPhrase, deleteConsequence, matchModeLabel, resolvedScopeKind, rulesSummary, scopeLabel } from "@/features/remote/lib/blocking";

const rule = (over: Partial<AppBlockRule> = {}): AppBlockRule => ({
  id: 1, name: "No games", exe_pattern: "steam.exe", match_mode: "exact", enabled: true, schedules: [], ...over,
});

describe("blocking helpers", () => {
  it("reads one scope per rule: summarised kind, then first scope row, else this device", () => {
    expect(resolvedScopeKind(rule({ scope_kind: "group" }))).toBe("group");
    expect(resolvedScopeKind(rule({ scopes: [{ kind: "all" }] }))).toBe("all");
    expect(resolvedScopeKind(rule())).toBe("agent");
    expect(resolvedScopeKind(rule({ scope_kind: "agent" }))).toBe("agent");
    expect(scopeLabel("all")).toBe("All devices");
    expect(scopeLabel("agent")).toBe("This device");
  });

  it("names match modes and capability statuses in plain words", () => {
    expect(matchModeLabel("exact")).toBe("Exact name");
    expect(matchModeLabel("contains")).toBe("Name contains");
    expect(capabilityPhrase("needs_privilege")).toBe("needs privilege");
    expect(capabilityPhrase(null)).toBe("unsupported");
  });

  it("only attributes a block to a rule when it did not come from this device", () => {
    expect(blockSourceLabel("group")).toBe("a group rule");
    expect(blockSourceLabel("all")).toBe("an all-devices rule");
    expect(blockSourceLabel("agent")).toBeNull();
    expect(blockSourceLabel(null)).toBeNull();
  });

  it("summarises how many rules are on", () => {
    expect(rulesSummary([])).toBe("No rules");
    expect(rulesSummary([rule()])).toBe("1 rule · all on");
    expect(rulesSummary([rule(), rule({ id: 2, enabled: false })])).toBe("2 rules · 1 on");
    expect(rulesSummary([rule({ enabled: false })])).toBe("1 rule · all off");
  });

  it("says where deleting a rule stops it, not only here", () => {
    expect(deleteConsequence(rule())).toContain("this device");
    expect(deleteConsequence(rule({ scope_kind: "all" }))).toContain("every device");
    expect(deleteConsequence(rule({ scope_kind: "group" }))).toContain("its group");
    expect(deleteConsequence(rule({ name: "" }))).toContain("steam.exe");
  });
});
