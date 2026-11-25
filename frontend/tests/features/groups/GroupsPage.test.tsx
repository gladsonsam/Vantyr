// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click, typeInto } from "@tests/support/formDom";
import { GroupsPage } from "@/features/groups/GroupsPage";
import { ruleCountsByGroup } from "@/features/groups/groupSummary";

const api = vi.hoisted(() => ({
  agentGroupsList: vi.fn(),
  agentGroupsCreate: vi.fn(async () => ({ id: "new" })),
  agentGroupsUpdate: vi.fn(async () => ({ ok: true })),
  agentGroupsDelete: vi.fn(async () => ({ ok: true })),
  agentGroupMembers: vi.fn(),
  agentGroupMembersAdd: vi.fn(async () => ({ added: 1 })),
  agentGroupMemberRemove: vi.fn(async () => ({ ok: true })),
  agentsOverview: vi.fn(),
  alertRulesList: vi.fn(),
  alertRulesCreate: vi.fn(async () => ({ id: 9 })),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e) }));
// The shell renders page actions into its header; here they render in place.
vi.mock("@/app/shell/AppShell", () => ({ PageActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const row = (id: string, name: string, description: string, member_count: number) => ({ id, name, description, created_at: "2026-10-01T00:00:00Z", member_count });
const groups = [row("g1", "Workstations", "Employee laptops", 2), row("g2", "Kiosks", "", 1)];
const agents = [{ id: "a1", name: "Alpha" }, { id: "a2", name: "Bravo" }, { id: "a3", name: "Charlie" }];
const rules = [
  { id: 1, name: "R1", scopes: [{ kind: "group", group_id: "g1" }] },
  { id: 2, name: "R2", scopes: [{ kind: "group", group_id: "g1" }, { kind: "group", group_id: "g1" }, { kind: "all" }] },
  { id: 3, name: "R3", scopes: [{ kind: "agent", agent_id: "a1" }] },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.agentGroupsList.mockResolvedValue({ groups });
  api.agentsOverview.mockResolvedValue({ agents });
  api.alertRulesList.mockResolvedValue({ rules });
  api.agentGroupMembers.mockResolvedValue({ agent_ids: ["a1", "a2"] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render(ui: ReactElement = <GroupsPage />) {
  await act(async () => root.render(withQueryClient(<MemoryRouter>{ui}</MemoryRouter>, createTestQueryClient())));
}
const rows = () => [...host.querySelectorAll('ul[aria-label="Agent groups"] > li')];
const btn = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
async function openMenu(group: string) {
  await click(btn(`More actions for ${group}`)!);
  await act(async () => {});
}
const menuItem = (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === name) as HTMLElement;

describe("GroupsPage list", () => {
  it("shows identity, description, device count and the alert rules that target each group", async () => {
    await render();
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toContain("Workstations");
    expect(rows()[0].textContent).toContain("Employee laptops");
    expect(rows()[0].textContent).toContain("2 devices");
    expect(rows()[0].textContent).toContain("2 alert rules");
    expect(rows()[1].textContent).toContain("1 device");
    expect(rows()[1].textContent).toContain("No alert rules");
    expect(rows()[0].querySelector("a")?.getAttribute("href")).toBe("/rules");
  });

  it("leaves the rule summary out when the rules failed to load instead of claiming none", async () => {
    api.alertRulesList.mockRejectedValue(new Error("nope"));
    await render();
    expect(rows()[1].textContent).not.toContain("alert rule");
    expect(rows()[1].textContent).toContain("1 device");
  });

  it("cuts a long description and lets the rest be read", async () => {
    const long = "Everything in the east wing: ".padEnd(160, "x");
    api.agentGroupsList.mockResolvedValue({ groups: [row("g1", "Wing", long, 0)] });
    await render();
    const more = btn("Show more")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(rows()[0].querySelector("p")?.className).toContain("line-clamp-2");
    await click(more);
    expect(btn("Show less")?.getAttribute("aria-expanded")).toBe("true");
    expect(rows()[0].querySelector("p")?.textContent).toBe(long);
  });

  it("shows an empty state that invites creating the first group", async () => {
    api.agentGroupsList.mockResolvedValue({ groups: [] });
    await render();
    expect(document.body.textContent).toContain("No groups yet");
    expect(btn("Create group", host)).toBeDefined();
  });

  it("offers retry when groups fail to load", async () => {
    api.agentGroupsList.mockRejectedValueOnce(new Error("503")).mockResolvedValue({ groups });
    await render();
    expect(host.textContent).toContain("Couldn’t load groups: 503");
    await click(btn("Try again")!);
    expect(rows()).toHaveLength(2);
  });

  it("only shows search for long lists, and an empty search can be cleared", async () => {
    await render();
    expect(host.querySelector('input[aria-label="Search groups"]')).toBeNull();
    const many = Array.from({ length: 7 }, (_, i) => row(`x${i}`, `Group ${i}`, i === 4 ? "needle here" : "", i));
    api.agentGroupsList.mockResolvedValue({ groups: many });
    await render(<GroupsPage key="again" />);
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search groups"]')!;
    await typeInto(search, "needle");
    expect(rows().map((r) => r.querySelector("h3")?.textContent)).toEqual(["Group 4"]);
    await typeInto(search, "zzz");
    expect(host.textContent).toContain("No groups match “zzz”");
    await click(btn("Clear search")!);
    expect(rows()).toHaveLength(7);
  });
});

describe("GroupsPage actions", () => {
  it("creates a group with the typed values and refreshes the list", async () => {
    await render();
    await click(btn("Create group", host)!);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Create group");
    await typeInto(document.querySelector<HTMLInputElement>("#group-name")!, "Front desk");
    await typeInto(document.querySelector<HTMLInputElement>("#group-description")!, "Reception");
    await click(btn("Create group", dialog()!)!);
    expect(api.agentGroupsCreate).toHaveBeenCalledWith({ name: "Front desk", description: "Reception" });
    expect(dialog()).toBeNull();
    expect(api.agentGroupsList).toHaveBeenCalledTimes(2);
  });

  it("edits the chosen group and shows a save failure inside the dialog", async () => {
    api.agentGroupsUpdate.mockRejectedValueOnce(new Error("Name taken"));
    await render();
    await click(btn("Edit Kiosks")!);
    expect(document.querySelector<HTMLInputElement>("#group-name")!.value).toBe("Kiosks");
    await click(btn("Save changes", dialog()!)!);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Name taken");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await click(btn("Save changes", dialog()!)!);
    expect(api.agentGroupsUpdate).toHaveBeenLastCalledWith("g2", { name: "Kiosks", description: "" });
    expect(dialog()).toBeNull();
  });

  it("states the consequences before deleting, and only deletes on confirm", async () => {
    await render();
    await openMenu("Workstations");
    await click(menuItem("Delete group…"));
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Delete “Workstations”?");
    expect(text).toContain("2 devices will stop inheriting rules through this group.");
    expect(text).toContain("2 alert rules that target it will lose that target.");
    expect(api.agentGroupsDelete).not.toHaveBeenCalled();
    await click(btn("Cancel", dialog()!)!);
    expect(api.agentGroupsDelete).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    await openMenu("Workstations");
    await click(menuItem("Delete group…"));
    await click(btn("Delete group", dialog()!)!);
    expect(api.agentGroupsDelete).toHaveBeenCalledWith("g1");
    expect(dialog()).toBeNull();
  });

  it("keeps the confirmation open with the reason when a delete fails", async () => {
    api.agentGroupsDelete.mockRejectedValueOnce(new Error("Group is in use"));
    await render();
    await openMenu("Kiosks");
    await click(menuItem("Delete group…"));
    await click(btn("Delete group", dialog()!)!);
    expect(dialog()?.textContent).toContain("Group is in use");
    await click(btn("Delete group", dialog()!)!);
    expect(dialog()).toBeNull();
  });

  it("opens the members dialog, loads the group's members and adds a device", async () => {
    await render();
    await click(btn("Members", rows()[0])!);
    await act(async () => {});
    expect(api.agentGroupMembers).toHaveBeenCalledWith("g1");
    expect(dialog()?.textContent).toContain("Members: Workstations");
    expect([...dialog()!.querySelectorAll('ul[aria-label="Devices in this group"] li p')].map((p) => p.textContent)).toEqual(["Alpha", "Bravo"]);
    await click([...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.startsWith("Add"))!);
    await click(dialog()!.querySelector<HTMLElement>('[role="checkbox"][aria-label="Add Charlie"]')!);
    api.agentGroupMembers.mockResolvedValue({ agent_ids: ["a1", "a2", "a3"] });
    await click(btn("Add 1 device", dialog()!)!);
    expect(api.agentGroupMembersAdd).toHaveBeenCalledWith("g1", { agent_ids: ["a3"] });
    // The member list and counts were re-read after the change.
    expect(api.agentGroupMembers).toHaveBeenCalledTimes(2);
    expect(api.agentGroupsList).toHaveBeenCalledTimes(2);
    expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe("Added 1 device to Workstations.");
    expect(dialog()?.textContent).toContain("In group (3)");
  });

  it("reports a failed member load in the dialog with a retry that recovers", async () => {
    api.agentGroupMembers.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ agent_ids: ["a1"] });
    await render();
    await click(btn("Members", rows()[0])!);
    await act(async () => {});
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load members: boom");
    await click(btn("Try again", dialog()!)!);
    expect(dialog()?.textContent).toContain("In group (1)");
  });

  it("returns focus to the button that opened the dialog when it closes", async () => {
    await render();
    const edit = btn("Edit Workstations")!;
    edit.focus();
    await click(edit);
    await click(btn("Cancel", dialog()!)!);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.activeElement).toBe(edit);
  });
});

describe("ruleCountsByGroup", () => {
  it("counts each rule once per group and ignores all- and device-scoped rules", () => {
    const counts = ruleCountsByGroup(rules as never);
    expect(counts.get("g1")).toBe(2);
    expect(counts.size).toBe(1);
  });
});
