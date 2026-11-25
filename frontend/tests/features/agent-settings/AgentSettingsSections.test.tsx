// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { AgentSettingsTab } from "@/features/agent-settings/AgentSettingsTab";
import { AgentGroupsCard } from "@/features/agent-settings/AgentGroupsCard";
import { AgentIconCard } from "@/features/agent-settings/AgentIconCard";

const api = vi.hoisted(() => ({
  agentIconGet: vi.fn(async () => ({ icon: "monitor" })),
  agentIconPut: vi.fn(),
  agentGroupsForAgent: vi.fn(),
  agentGroupsList: vi.fn(),
  agentGroupMembersAdd: vi.fn(async () => ({ added: 1 })),
  agentGroupMemberRemove: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e) }));
vi.mock("@/api/serverVersionStore", () => ({ useServerVersionPayload: () => null }));
vi.mock("@/features/agent-settings/AgentModuleSettings", () => ({ AgentModuleSettings: () => <div>Module controls</div> }));
vi.mock("@/features/agent-settings/AgentReplacementSettings", () => ({ AgentReplacementSettings: () => <div>Replace installation</div> }));
vi.mock("@/features/agent-settings/AgentRetentionCard", () => ({ AgentRetentionCard: () => <div>Retention card</div> }));
vi.mock("@/features/agent-settings/AgentUpdateCards", () => ({ AgentUpdateCard: () => <div>Update card</div>, AgentAutoUpdateCard: () => <div>Auto update card</div> }));
vi.mock("@/features/recall/components/AgentRecallSettings", () => ({ AgentRecallSettings: () => <div>Recall settings</div> }));
vi.mock("@/api/queries/settings", () => ({
  settingsQueries: {
    agentRetention: () => ({ queryKey: ["retention"], queryFn: async () => ({}) }),
    agentAutoUpdate: () => ({ queryKey: ["auto-update"], queryFn: async () => ({}) }),
  },
}));

const groups = [
  { id: "g1", name: "Workstations", description: "Employee laptops", created_at: "2026-10-01T00:00:00Z", member_count: 3 },
  { id: "g2", name: "Kiosks", description: "", created_at: "2026-10-01T00:00:00Z", member_count: 1 },
];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.agentGroupsForAgent.mockResolvedValue({ groups: [groups[0]] });
  api.agentGroupsList.mockResolvedValue({ groups });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
async function render(ui: ReactElement) {
  await act(async () => root.render(withQueryClient(ui, createTestQueryClient())));
}
const sections = () => [...host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Agent settings sections"] [role="tab"]')];
const button = (name: string) => [...document.body.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name);

describe("agent settings sections", () => {
  const props = { agentId: "a", agentName: "Office PC", agentOnline: true, agentVersion: "1.0", onDeleteAgent: vi.fn() };
  it("lists every section an admin can use, with the first one open, and reaches the later ones", async () => {
    await render(<AgentSettingsTab {...props} isAdmin dashboardRole="admin" />);
    expect(sections().map((tab) => tab.textContent)).toEqual(["Modules", "General", "Groups", "Retention", "Recall", "Updates"]);
    expect(sections()[0].getAttribute("aria-selected")).toBe("true");
    for (const [index, text] of [[3, "Retention card"], [4, "Recall settings"], [5, "Update card"]] as const) {
      await act(async () => sections()[index].click());
      expect(sections()[index].getAttribute("aria-selected")).toBe("true");
      expect(host.textContent).toContain(text);
    }
  });
  it("shows a viewer only the sections they can use and falls back when their open section disappears", async () => {
    await render(<AgentSettingsTab {...props} isAdmin dashboardRole="admin" />);
    expect(sections()[0].textContent).toBe("Modules");
    await render(<AgentSettingsTab {...props} isAdmin={false} dashboardRole="viewer" />);
    expect(sections().map((tab) => tab.textContent)).toEqual(["General", "Retention", "Recall", "Updates"]);
    expect(sections()[0].getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).not.toContain("Module controls");
    // Viewers see the identity but cannot change the icon, and have no replacement or deletion.
    expect(host.textContent).toContain("Office PC");
    expect(button("Change icon")?.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).not.toContain("Replace installation");
    expect(host.textContent).not.toContain("Delete agent");
  });
  it("keeps the delete action with its consequence under General for admins", async () => {
    await render(<AgentSettingsTab {...props} isAdmin dashboardRole="admin" />);
    await act(async () => sections()[1].click());
    expect(host.textContent).toContain("Permanently removes this device and its history");
    await act(async () => button("Delete agent")!.click());
    expect(props.onDeleteAgent).toHaveBeenCalledTimes(1);
  });
});

describe("agent groups", () => {
  it("shows membership with one heading, a named remove action and the add control", async () => {
    await render(<AgentGroupsCard agentId="a" onOpenAgentGroups={vi.fn()} />);
    expect(host.textContent).toContain("In 1 group");
    expect(host.textContent).toContain("Employee laptops");
    expect(button("Remove from Workstations")?.textContent).toBe("Remove");
    expect(host.textContent).not.toContain("Agent groups");
    expect(button("Manage groups")).toBeDefined();
  });
  it("removes a membership and moves focus to the outcome", async () => {
    await render(<AgentGroupsCard agentId="a" />);
    await act(async () => button("Remove from Workstations")!.click());
    expect(api.agentGroupMemberRemove).toHaveBeenCalledWith("g1", "a");
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    expect(document.activeElement?.textContent).toBe("Removed from group.");
  });
  it("says so when the device is in no group", async () => {
    api.agentGroupsForAgent.mockResolvedValue({ groups: [] });
    await render(<AgentGroupsCard agentId="a" />);
    expect(host.textContent).toContain("Not in any group");
  });
  it("does not claim membership when the lookup fails", async () => {
    api.agentGroupsForAgent.mockRejectedValue(new Error("groups down"));
    await render(<AgentGroupsCard agentId="a" />);
    expect(host.textContent).toContain("groups down");
    expect(host.textContent).not.toContain("Not in any group");
    expect(host.textContent).not.toContain("In 0 groups");
  });
});

describe("agent icon", () => {
  it("names the device, offers a labelled change action and reports a saved icon", async () => {
    api.agentIconPut.mockResolvedValue({ icon: "server" });
    await render(<AgentIconCard agentId="a" agentName="Office PC" canOperate />);
    expect(host.textContent).toContain("Office PC");
    await act(async () => button("Change icon")!.click());
    await act(async () => (document.body.querySelector('[aria-label="server"]') as HTMLElement).click());
    expect(api.agentIconPut).toHaveBeenCalledWith("a", "server");
    expect(host.textContent).toContain("Icon saved.");
  });
});
