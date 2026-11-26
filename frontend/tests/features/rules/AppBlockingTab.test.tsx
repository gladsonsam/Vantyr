import { createTabHarness } from "@tests/support/ruleTab";
import { click, typeInto } from "@tests/support/formDom";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";

const api = (() => ({
  appBlockRulesList: vi.fn(),
  appBlockRulesCreate: vi.fn(async () => ({ id: 9 })),
  appBlockRulesUpdate: vi.fn(async () => ({ ok: true })),
  appBlockRulesDelete: vi.fn(async () => ({ ok: true })),
  appBlockEventsForRule: vi.fn(),
}))();
await vi.mock("@/api", () => ({
  api,
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  apiUrl: (p: string) => p,
}));
await vi.mock("@/components/common/AppIcon", () => ({ AppIcon: () => null }));

const { AppBlockingTab } = await import("@/features/rules/AppBlockingTab");

const rule = (id: number, patch: Partial<AppBlockRule> = {}): AppBlockRule => ({
  id,
  name: `Rule ${id}`,
  exe_pattern: `app${id}.exe`,
  match_mode: "exact",
  enabled: true,
  created_at: "",
  scopes: [{ kind: "all" }],
  schedules: [],
  ...patch,
});
const rules: AppBlockRule[] = [
  rule(1, { name: "Block games", exe_pattern: "steam.exe" }),
  rule(2, {
    name: "Study hours",
    exe_pattern: "game",
    match_mode: "contains",
    scopes: [
      { kind: "group", group_id: "g1" },
      { kind: "agent", agent_id: "a1" },
    ],
    schedules: [1, 2, 3, 4, 5].map((d) => ({
      day_of_week: d,
      start_minute: 9 * 60,
      end_minute: 17 * 60,
    })),
  }),
  rule(3, { name: "", exe_pattern: "tor.exe", enabled: false }),
];
const groups = [{ id: "g1", name: "Lab" }] as AgentGroup[];
const agents = [{ id: "a1", name: "Alpha" }] as Agent[];

const t = createTabHarness();
beforeEach(() => {
  t.setup();
  api.appBlockRulesList.mockResolvedValue({ rules });
  api.appBlockEventsForRule.mockResolvedValue({ rows: [] });
});
afterEach(async () => {
  await t.teardown();
  vi.clearAllMocks();
});

const render = () => t.render(<AppBlockingTab groups={groups} agents={agents} />);
const items = () => t.items("App block rules");

describe("AppBlockingTab list", () => {
  it("shows the app, where it applies and when, and says what an off rule does", async () => {
    await render();
    expect(items()).toHaveLength(3);
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("3 rules · 2 on");
    const first = items()[0].textContent ?? "";
    expect(first).toContain("Block games");
    expect(first).toContain("steam.exe");
    expect(first).toContain("Exact name");
    expect(first).toContain("All devices");
    expect(first).toContain("Always");
    const second = items()[1].textContent ?? "";
    expect(second).toContain("Name contains");
    expect(second).toContain("Group · Lab, Agent · Alpha");
    expect(second).toContain("Mon–Fri 09:00–17:00 · device time");
    expect(items()[2].querySelector("h3")?.textContent).toBe("tor.exe");
    expect(items()[2].textContent).toContain("Off, not blocking");
    expect(items()[0].textContent).not.toContain("Off, not blocking");
    expect(t.switchOf(items()[2]).getAttribute("aria-checked")).toBe("false");
  });

  it("invites adding the first rule", async () => {
    api.appBlockRulesList.mockResolvedValue({ rules: [] });
    await render();
    expect(t.host.textContent).toContain("No app block rules yet");
    await click(t.btn("New rule", t.host)!);
    expect(t.dialog()?.querySelector("h2")?.textContent).toBe("New app block rule");
  });

  it("says the load failed and retries instead of showing an empty list", async () => {
    api.appBlockRulesList.mockRejectedValueOnce(new Error("503")).mockResolvedValue({ rules });
    await render();
    expect(t.host.textContent).toContain("Couldn’t load app block rules: 503");
    expect(t.host.textContent).not.toContain("No app block rules yet");
    await click(t.btn("Try again")!);
    expect(items()).toHaveLength(3);
  });

  it("keeps the last list and says the refresh failed", async () => {
    await render();
    api.appBlockRulesList.mockRejectedValue(new Error("offline"));
    await click(t.btn("Edit Block games")!);
    await click(t.btn("Save changes", t.dialog()!)!);
    await act(async () => {});
    expect(items()).toHaveLength(3);
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t refresh app block rules: offline. Showing the last list that loaded.",
    );
  });

  it("only offers search for a long list and finds by app, name and scope", async () => {
    await render();
    expect(t.host.querySelector('input[aria-label="Search app block rules"]')).toBeNull();
    api.appBlockRulesList.mockResolvedValue({
      rules: Array.from({ length: 7 }, (_, i) =>
        rule(i + 10, {
          exe_pattern: `x${i}.exe`,
          scopes: [{ kind: i === 3 ? "group" : "all", group_id: i === 3 ? "g1" : undefined }],
        }),
      ),
    });
    await t.render(<AppBlockingTab key="2" groups={groups} agents={agents} />);
    const search = t.host.querySelector<HTMLInputElement>(
      'input[aria-label="Search app block rules"]',
    )!;
    await typeInto(search, "lab");
    expect(items().map((i) => i.querySelector("h3")?.textContent)).toEqual(["Rule 13"]);
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("1 of 7 rules");
    await typeInto(search, "zzz");
    expect(t.host.textContent).toContain("Nothing matches “zzz”.");
    await click(t.btn("Clear search")!);
    expect(items()).toHaveLength(7);
  });
});

describe("AppBlockingTab switch", () => {
  it("flips only enabled and shows the server's answer", async () => {
    await render();
    await click(t.switchOf(items()[2]));
    expect(api.appBlockRulesUpdate).toHaveBeenCalledWith(3, { enabled: true });
    expect(t.switchOf(items()[2]).getAttribute("aria-checked")).toBe("true");
  });

  it("names the rule and the reason when the server refuses, and leaves the switch as it was", async () => {
    api.appBlockRulesUpdate.mockRejectedValueOnce(new Error("Forbidden"));
    await render();
    await click(t.switchOf(items()[0]));
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t turn off “Block games”: Forbidden",
    );
    expect(t.switchOf(items()[0]).getAttribute("aria-checked")).toBe("true");
    await click(t.btn("Dismiss")!);
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("AppBlockingTab delete", () => {
  it("says where the rule stops and what stays before deleting, and only deletes on confirm", async () => {
    await render();
    await t.openMenu("Study hours");
    await click(t.menuItem("Delete rule"));
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("Delete “Study hours”?");
    expect(text).toContain("game stops being closed on Group · Lab, Agent · Alpha");
    expect(text).toContain("offline devices when they reconnect");
    expect(text).toContain("stays in Events");
    expect(api.appBlockRulesDelete).not.toHaveBeenCalled();
    await click(t.btn("Delete", t.dialog()!)!);
    expect(api.appBlockRulesDelete).toHaveBeenCalledWith(2);
    expect(t.dialog()).toBeNull();
    expect(items()).toHaveLength(2);
    expect(t.host.textContent).toContain("Deleted “Study hours”.");
  });

  it("keeps the confirmation open with the reason when the delete fails", async () => {
    api.appBlockRulesDelete.mockRejectedValueOnce(new Error("Not found"));
    await render();
    await t.openMenu("Block games");
    await click(t.menuItem("Delete rule"));
    await click(t.btn("Delete", t.dialog()!)!);
    expect(t.dialog()?.textContent).toContain("Couldn’t delete it: Not found");
    await click(t.btn("Delete", t.dialog()!)!);
    expect(t.dialog()).toBeNull();
  });
});

describe("AppBlockingTab edit and history", () => {
  it("opens the form filled in and reports a refused save inside the dialog", async () => {
    api.appBlockRulesUpdate.mockRejectedValueOnce(new Error("exe_pattern is protected"));
    await render();
    await click(t.btn("Edit Block games")!);
    expect(t.dialog()?.querySelector("h2")?.textContent).toBe("Edit app block rule");
    expect(document.querySelector<HTMLInputElement>("#appblock-exe")!.value).toBe("steam.exe");
    await click(t.btn("Save changes", t.dialog()!)!);
    expect(t.dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t save the rule: exe_pattern is protected",
    );
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
    await click(t.btn("Save changes", t.dialog()!)!);
    expect(api.appBlockRulesUpdate).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ exe_pattern: "steam.exe", match_mode: "exact", schedules: [] }),
    );
    expect(t.dialog()).toBeNull();
    expect(t.host.textContent).toContain("Saved “Block games”.");
  });

  it("lists each closure with its time, agent and app", async () => {
    api.appBlockEventsForRule.mockResolvedValue({
      rows: [
        {
          id: 1,
          agent_id: "a1",
          agent_name: "Alpha",
          rule_id: 1,
          rule_name: "Block games",
          exe_name: "steam.exe",
          killed_at: "2026-11-01T10:00:00Z",
        },
      ],
    });
    await render();
    await click(t.btn("Closed-app history for Block games")!);
    await act(async () => {});
    expect(api.appBlockEventsForRule).toHaveBeenCalledWith(1, { limit: 200 });
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("History · Block games");
    expect(text).toContain("1 closure, newest first.");
    expect(text).toContain("Alpha");
    expect(text).toContain("steam.exe");
  });

  it("says when the history could not be loaded instead of 'nothing closed', and retries", async () => {
    api.appBlockEventsForRule
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ rows: [] });
    await render();
    await click(t.btn("Closed-app history for Block games")!);
    await act(async () => {});
    expect(t.dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load this rule’s history: timeout",
    );
    expect(t.dialog()?.textContent).not.toContain("Nothing closed yet");
    await click(t.btn("Try again", t.dialog()!)!);
    await act(async () => {});
    expect(t.dialog()?.textContent).toContain("Nothing closed yet");
  });

  it("says when only the latest closures are shown", async () => {
    api.appBlockEventsForRule.mockResolvedValue({
      rows: Array.from({ length: 200 }, (_, i) => ({
        id: i + 1,
        agent_id: "a1",
        agent_name: "Alpha",
        rule_id: 1,
        rule_name: "x",
        exe_name: "steam.exe",
        killed_at: "2026-11-01T10:00:00Z",
      })),
    });
    await render();
    await click(t.btn("Closed-app history for Block games")!);
    await act(async () => {});
    expect(t.dialog()?.textContent).toContain(
      "200 closures, newest first. Only the latest 200 are shown.",
    );
  });
});
