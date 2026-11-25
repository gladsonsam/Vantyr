// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click } from "@tests/support/formDom";
import { createTabHarness } from "@tests/support/ruleTab";
import { InternetAccessTab } from "@/features/rules/InternetAccessTab";
import type { Agent, AgentGroup, InternetBlockRule } from "@/api/types";

const api = vi.hoisted(() => ({
  internetBlockRulesList: vi.fn(),
  internetBlockRulesCreate: vi.fn(async () => ({ id: 9 })),
  internetBlockRulesUpdate: vi.fn(async () => ({ ok: true })),
  internetBlockRulesDelete: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)), apiUrl: (p: string) => p }));

const rule = (id: number, patch: Partial<InternetBlockRule> = {}): InternetBlockRule => ({
  id, name: `Rule ${id}`, enabled: true, created_at: "2026-10-01T00:00:00Z", scopes: [{ kind: "all" }], schedules: [], ...patch,
});
const rules: InternetBlockRule[] = [
  rule(1, { name: "Always off" }),
  rule(2, {
    name: "School nights", scopes: [{ kind: "group", group_id: "g1" }],
    schedules: [{ day_of_week: 0, start_minute: 21 * 60, end_minute: 1440 }, { day_of_week: 1, start_minute: 0, end_minute: 7 * 60 }],
  }),
  rule(3, { name: "", enabled: false, scopes: [{ kind: "agent", agent_id: "a1" }] }),
  rule(4, { name: "Paused always", enabled: false }),
];
const groups = [{ id: "g1", name: "Lab" }] as AgentGroup[];
const agents = [{ id: "a1", name: "Alpha" }] as Agent[];

const t = createTabHarness();
beforeEach(() => {
  t.setup();
  api.internetBlockRulesList.mockResolvedValue({ rules });
});
afterEach(async () => {
  await t.teardown();
  vi.clearAllMocks();
});

const render = () => t.render(<InternetAccessTab groups={groups} agents={agents} />);
const items = () => t.items("Internet block rules");

describe("InternetAccessTab list", () => {
  it("shows who each rule blocks and when, in the device's time", async () => {
    await render();
    expect(items()).toHaveLength(4);
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("4 rules · 2 on");
    expect(items()[0].textContent).toContain("Blocks All devices");
    expect(items()[0].textContent).toContain("Always");
    const second = items()[1].textContent ?? "";
    expect(second).toContain("Blocks Group · Lab");
    expect(second).toContain("Sun 21:00 → Mon 07:00 · device time");
    // An unnamed rule still has a title, and an off one says it blocks nothing.
    expect(items()[2].querySelector("h3")?.textContent).toBe("Internet block");
    expect(items()[2].textContent).toContain("Off, not blocking");
  });

  it("invites adding the first rule", async () => {
    api.internetBlockRulesList.mockResolvedValue({ rules: [] });
    await render();
    expect(t.host.textContent).toContain("No internet block rules yet");
    await click(t.btn("New rule", t.host)!);
    expect(t.dialog()?.querySelector("h2")?.textContent).toBe("New internet block rule");
  });

  it("says the load failed and retries instead of showing an empty list", async () => {
    api.internetBlockRulesList.mockRejectedValueOnce(new Error("503")).mockResolvedValue({ rules });
    await render();
    expect(t.host.textContent).toContain("Couldn’t load internet block rules: 503");
    expect(t.host.textContent).not.toContain("No internet block rules yet");
    await click(t.btn("Try again")!);
    expect(items()).toHaveLength(4);
  });
});

describe("InternetAccessTab switch", () => {
  it("turns a rule off straight away, naming the rule when the server refuses", async () => {
    api.internetBlockRulesUpdate.mockRejectedValueOnce(new Error("Forbidden"));
    await render();
    await click(t.switchOf(items()[0]));
    expect(api.internetBlockRulesUpdate).toHaveBeenCalledWith(1, { enabled: false });
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t turn off “Always off”: Forbidden");
    expect(t.switchOf(items()[0]).getAttribute("aria-checked")).toBe("true");
  });

  it("asks before switching on a rule with no schedule, because it cuts devices off at once", async () => {
    await render();
    await click(t.switchOf(items()[3]));
    expect(api.internetBlockRulesUpdate).not.toHaveBeenCalled();
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("Turn on “Paused always”?");
    expect(text).toContain("internet access is cut on All devices");
    expect(text).toContain("offline ones when they reconnect");
    expect(text).toContain("connection to Vantyr keeps working");
    await click(t.btn("Cancel", t.dialog()!)!);
    expect(api.internetBlockRulesUpdate).not.toHaveBeenCalled();
    await click(t.switchOf(items()[3]));
    await click(t.btn("Block internet", t.dialog()!)!);
    expect(api.internetBlockRulesUpdate).toHaveBeenCalledWith(4, { enabled: true });
    expect(t.dialog()).toBeNull();
    expect(t.switchOf(items()[3]).getAttribute("aria-checked")).toBe("true");
  });

  it("switches on a scheduled rule without asking, since it only blocks in its hours", async () => {
    await render();
    api.internetBlockRulesList.mockResolvedValue({ rules: [rule(5, { name: "Nights", enabled: false, schedules: [{ day_of_week: 1, start_minute: 0, end_minute: 60 }] })] });
    await t.render(<InternetAccessTab key="2" groups={groups} agents={agents} />);
    await click(t.switchOf(items()[0]));
    expect(t.dialog()).toBeNull();
    expect(api.internetBlockRulesUpdate).toHaveBeenCalledWith(5, { enabled: true });
  });

  it("tells the user when a confirmed switch-on is refused", async () => {
    api.internetBlockRulesUpdate.mockRejectedValueOnce(new Error("Forbidden"));
    await render();
    await click(t.switchOf(items()[3]));
    await click(t.btn("Block internet", t.dialog()!)!);
    expect(t.dialog()).toBeNull();
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t turn on “Paused always”: Forbidden");
  });
});

describe("InternetAccessTab delete", () => {
  it("says who is unblocked, and that another rule can still block, and only deletes on confirm", async () => {
    await render();
    await t.openMenu("School nights");
    await click(t.menuItem("Delete rule"));
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("Delete “School nights”?");
    expect(text).toContain("It stops blocking Group · Lab");
    expect(text).toContain("another rule or a manual block still covers");
    expect(api.internetBlockRulesDelete).not.toHaveBeenCalled();
    await click(t.btn("Delete", t.dialog()!)!);
    expect(api.internetBlockRulesDelete).toHaveBeenCalledWith(2);
    expect(items()).toHaveLength(3);
    expect(t.host.textContent).toContain("Deleted “School nights”.");
  });

  it("keeps the confirmation open with the reason when the delete fails", async () => {
    api.internetBlockRulesDelete.mockRejectedValueOnce(new Error("Not found"));
    await render();
    await t.openMenu("Always off");
    await click(t.menuItem("Delete rule"));
    await click(t.btn("Delete", t.dialog()!)!);
    expect(t.dialog()?.textContent).toContain("Couldn’t delete it: Not found");
  });
});

describe("InternetAccessTab schedule and create", () => {
  it("opens an always-on rule without set hours and keeps it always-on when saved", async () => {
    await render();
    await click(t.btn("Edit schedule of Always off")!);
    expect(t.dialog()?.querySelector("h2")?.textContent).toBe("Schedule · Always off");
    await click(t.btn("Save schedule", t.dialog()!)!);
    expect(api.internetBlockRulesUpdate).toHaveBeenCalledWith(1, { enabled: true, schedules: [] });
    expect(t.dialog()).toBeNull();
    expect(t.host.textContent).toContain("Saved the schedule of “Always off”.");
  });

  it("reports a refused schedule save inside the dialog", async () => {
    api.internetBlockRulesUpdate.mockRejectedValueOnce(new Error("Forbidden"));
    await render();
    await click(t.btn("Edit schedule of School nights")!);
    await click(t.btn("Save schedule", t.dialog()!)!);
    expect(t.dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save the schedule: Forbidden");
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("creates a rule and reports a refused create inside the dialog", async () => {
    api.internetBlockRulesCreate.mockRejectedValueOnce(new Error("Too many rules"));
    await render();
    await click(t.btn("New rule", t.host)!);
    await click(t.btn("Create rule", t.dialog()!)!);
    expect(t.dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t create the rule: Too many rules");
    await click(t.btn("Create rule", t.dialog()!)!);
    await act(async () => {});
    expect(api.internetBlockRulesCreate).toHaveBeenLastCalledWith(expect.objectContaining({ scopes: [{ kind: "all", group_id: undefined, agent_id: undefined }] }));
    expect(t.dialog()).toBeNull();
    expect(t.host.textContent).toContain("Added “Internet block”.");
  });
});
