// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click, typeInto } from "@tests/support/formDom";
import { AlertRulesTab } from "@/features/rules/AlertRulesTab";
import type { Agent, AgentGroup, AlertRule } from "@/api/types";

const api = vi.hoisted(() => ({
  alertRulesList: vi.fn(),
  alertRulesCreate: vi.fn(async () => ({ id: 9 })),
  alertRulesUpdate: vi.fn(async () => ({ ok: true })),
  alertRulesDelete: vi.fn(async () => ({ ok: true })),
  alertRuleEvents: vi.fn(),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)), apiUrl: (p: string) => p }));

const rule = (id: number, patch: Partial<AlertRule> = {}): AlertRule => ({
  id, name: `Rule ${id}`, channel: "url", pattern: `site${id}.com`, match_mode: "substring", case_insensitive: true,
  cooldown_secs: 300, enabled: true, take_screenshot: false, scopes: [{ kind: "all" }], ...patch,
});
const rules: AlertRule[] = [
  rule(1, { name: "Social media", pattern: "facebook.com" }),
  rule(2, { name: "Credentials", channel: "keys", pattern: "password", cooldown_secs: 900, take_screenshot: true, scopes: [{ kind: "group", group_id: "g1" }, { kind: "agent", agent_id: "a1" }, { kind: "group", group_id: "g2" }] }),
  rule(3, { name: "", channel: "resource", pattern: "", metric: "cpu_pct", comparator: "gt", threshold: 90, enabled: false }),
];
const groups = [{ id: "g1", name: "Lab" }, { id: "g2", name: "Kiosks" }] as AgentGroup[];
const agents = [{ id: "a1", name: "Alpha" }] as Agent[];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.alertRulesList.mockResolvedValue({ rules });
  api.alertRuleEvents.mockResolvedValue({ rows: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render() {
  await act(async () =>
    root.render(withQueryClient(<MemoryRouter><AlertRulesTab groups={groups} agents={agents} /></MemoryRouter>, createTestQueryClient())),
  );
}
const items = () => [...host.querySelectorAll('ul[aria-label="Alert rules"] > li')];
const btn = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const menuItem = (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim().startsWith(name)) as HTMLElement;
async function openMenu(title: string) {
  await click(btn(`More actions for ${title}`)!);
  await act(async () => {});
}

describe("AlertRulesTab list", () => {
  it("shows what each rule watches, where it applies and whether it is on", async () => {
    await render();
    expect(items()).toHaveLength(3);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("3 rules · 2 on");
    const first = items()[0].textContent ?? "";
    expect(first).toContain("Social media");
    expect(first).toContain("URL");
    expect(first).toContain("facebook.com");
    expect(first).toContain("All devices");
    expect(first).toContain("Once per 5 min");
    const second = items()[1].textContent ?? "";
    expect(second).toContain("Group · Lab, Agent · Alpha +1 more");
    expect(second).toContain("Screenshot");
    expect(second).toContain("Once per 15 min");
    // An unnamed rule is listed under its condition, and an off rule says so.
    expect(items()[2].querySelector("h3")?.textContent).toBe("CPU > 90%");
    expect(items()[2].textContent).toContain("Off, not firing");
    expect(items()[0].textContent).not.toContain("Off, not firing");
    expect(items()[2].querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it("only offers search for a long list and searches name, match, channel and scope", async () => {
    await render();
    expect(host.querySelector('input[aria-label="Search alert rules"]')).toBeNull();
    const many = Array.from({ length: 7 }, (_, i) => rule(i + 10, { name: `Many ${i}`, scopes: [{ kind: "group", group_id: i === 4 ? "g2" : "g1" }] }));
    api.alertRulesList.mockResolvedValue({ rules: many });
    await act(async () => root.render(withQueryClient(<MemoryRouter><AlertRulesTab key="2" groups={groups} agents={agents} /></MemoryRouter>, createTestQueryClient())));
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search alert rules"]')!;
    await typeInto(search, "kiosks");
    expect(items().map((i) => i.querySelector("h3")?.textContent)).toEqual(["Many 4"]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("1 of 7 rules");
    await typeInto(search, "zzz");
    expect(host.textContent).toContain("Nothing matches “zzz”.");
    await click(btn("Clear search")!);
    expect(items()).toHaveLength(7);
  });

  it("invites creating the first rule when there are none", async () => {
    api.alertRulesList.mockResolvedValue({ rules: [] });
    await render();
    expect(host.textContent).toContain("No alert rules yet");
    await click(btn("New rule", host)!);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("New alert rule");
  });

  it("says the load failed and offers a retry instead of showing an empty list", async () => {
    api.alertRulesList.mockRejectedValueOnce(new Error("503")).mockResolvedValue({ rules });
    await render();
    expect(host.textContent).toContain("Couldn’t load alert rules: 503");
    expect(host.textContent).not.toContain("No alert rules yet");
    await click(btn("Try again")!);
    expect(items()).toHaveLength(3);
  });
});

describe("AlertRulesTab switch", () => {
  it("sends the whole rule with only enabled flipped, and refreshes the list", async () => {
    await render();
    await click(items()[2].querySelector<HTMLElement>('[role="switch"]')!);
    expect(api.alertRulesUpdate).toHaveBeenCalledTimes(1);
    expect(api.alertRulesUpdate).toHaveBeenCalledWith(3, {
      name: "", channel: "resource", pattern: "", match_mode: "substring", case_insensitive: true, cooldown_secs: 300,
      enabled: true, take_screenshot: false, metric: "cpu_pct", comparator: "gt", threshold: 90, duration_secs: undefined,
      scopes: [{ kind: "all", group_id: undefined, agent_id: undefined }],
    });
    expect(api.alertRulesList).toHaveBeenCalledTimes(2);
  });

  it("names the rule and the reason when the server refuses, and leaves the switch where the server has it", async () => {
    api.alertRulesUpdate.mockRejectedValueOnce(new Error("Forbidden"));
    await render();
    await click(items()[0].querySelector<HTMLElement>('[role="switch"]')!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t turn off “Social media”: Forbidden");
    expect(items()[0].querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    await click(btn("Dismiss")!);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("AlertRulesTab delete", () => {
  it("says where the rule stops and what remains before deleting, and only deletes on confirm", async () => {
    await render();
    await openMenu("Credentials");
    await click(menuItem("Delete rule"));
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Delete “Credentials”?");
    expect(text).toContain("Group · Lab, Agent · Alpha, Group · Kiosks");
    expect(text).toContain("Alerts it already raised stay in Events");
    expect(api.alertRulesDelete).not.toHaveBeenCalled();
    await click(btn("Cancel", dialog()!)!);
    expect(api.alertRulesDelete).not.toHaveBeenCalled();
    await openMenu("Credentials");
    await click(menuItem("Delete rule"));
    await click(btn("Delete", dialog()!)!);
    expect(api.alertRulesDelete).toHaveBeenCalledWith(2);
    expect(dialog()).toBeNull();
    expect(host.textContent).toContain("Deleted “Credentials”.");
  });

  it("keeps the confirmation open with the reason when the delete fails", async () => {
    api.alertRulesDelete.mockRejectedValueOnce(new Error("Rule not found"));
    await render();
    await openMenu("Social media");
    await click(menuItem("Delete rule"));
    await click(btn("Delete", dialog()!)!);
    expect(dialog()?.textContent).toContain("Couldn’t delete it: Rule not found");
    await click(btn("Delete", dialog()!)!);
    expect(dialog()).toBeNull();
  });
});

describe("AlertRulesTab edit and history", () => {
  it("opens the edit form filled in and reports a refused save inside the dialog", async () => {
    api.alertRulesUpdate.mockRejectedValueOnce(new Error("invalid regex"));
    await render();
    await click(btn("Edit Social media")!);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Edit alert rule");
    expect(document.querySelector<HTMLInputElement>("#alert-rule-pattern")!.value).toBe("facebook.com");
    await click(btn("Save changes", dialog()!)!);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save the rule: invalid regex");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await click(btn("Save changes", dialog()!)!);
    expect(api.alertRulesUpdate).toHaveBeenLastCalledWith(1, expect.objectContaining({ name: "Social media", pattern: "facebook.com", enabled: true }));
    expect(dialog()).toBeNull();
    expect(host.textContent).toContain("Saved “Social media”.");
  });

  it("creates a rule with the typed pattern", async () => {
    await render();
    await click(btn("New rule", host)!);
    await typeInto(document.querySelector<HTMLInputElement>("#alert-rule-pattern")!, "twitch.tv");
    await click(btn("Create rule", dialog()!)!);
    expect(api.alertRulesCreate).toHaveBeenCalledWith(expect.objectContaining({ pattern: "twitch.tv", channel: "url", enabled: true, scopes: [{ kind: "all", group_id: undefined, agent_id: undefined }] }));
    expect(dialog()).toBeNull();
  });

  it("lists the alerts a rule raised, with the matched text and a deep link to the agent's activity", async () => {
    api.alertRuleEvents.mockResolvedValue({
      rows: [
        { id: 5, agent_id: "a1", agent_name: "Alpha", rule_name: "Social media", channel: "url", snippet: "facebook.com/profile?id=1", has_screenshot: true, screenshot_requested: true, created_at: "2026-11-01T10:00:00Z" },
        { id: 4, agent_id: "a1", agent_name: "Alpha", rule_name: "Social media", channel: "url", snippet: "", has_screenshot: false, screenshot_requested: true, created_at: "2026-11-01T09:00:00Z" },
      ],
    });
    await render();
    await click(btn("Event history for Social media")!);
    await act(async () => {});
    expect(api.alertRuleEvents).toHaveBeenCalledWith(1, { limit: 200 });
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("History · Social media");
    expect(text).toContain("2 alerts, newest first.");
    expect(text).toContain("facebook.com/profile?id=1");
    expect(text).toContain("No screenshot");
    expect([...dialog()!.querySelectorAll("button")].some((b) => b.getAttribute("aria-label")?.startsWith("View screenshot from"))).toBe(true);
    expect(dialog()!.querySelector("a")?.getAttribute("href")).toBe("/agents/a1?tab=activity&at=2026-11-01T10%3A00%3A00Z");
  });

  it("says when the history could not be loaded instead of 'no events', and retries", async () => {
    api.alertRuleEvents.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ rows: [] });
    await render();
    await click(btn("Event history for Social media")!);
    await act(async () => {});
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load this rule’s history: timeout");
    expect(dialog()?.textContent).not.toContain("No alerts yet");
    await click(btn("Try again", dialog()!)!);
    await act(async () => {});
    expect(dialog()?.textContent).toContain("No alerts yet");
  });

  it("says when older alerts are not shown", async () => {
    api.alertRuleEvents.mockResolvedValue({
      rows: Array.from({ length: 200 }, (_, i) => ({ id: i + 1, agent_id: "a1", agent_name: "Alpha", rule_name: "x", channel: "url", snippet: `s${i}`, has_screenshot: false, screenshot_requested: false, created_at: "2026-11-01T10:00:00Z" })),
    });
    await render();
    await click(btn("Event history for Social media")!);
    await act(async () => {});
    expect(dialog()?.textContent).toContain("200 alerts, newest first. Older alerts may not be shown.");
  });
});
