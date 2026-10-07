// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsTab } from "@/components/AgentSettingsTab";
import { SettingsPage } from "@/pages/SettingsPage";
import { SecuritySettings } from "./SecuritySettings";
import { SessionContext, type SessionContextValue } from "@/app/providers/useSession";
const api = vi.hoisted(() => ({
  retentionAgentGet: vi.fn(async () => ({ global: { keylog_days: 7, window_days: 7, url_days: 7 }, override: null })),
  agentIconGet: vi.fn(async () => ({ icon: "monitor" })),
  agentAutoUpdateAgentGet: vi.fn(async () => ({ global: { enabled: true }, override: null })),
  agentGroupsForAgent: vi.fn(async () => ({ groups: [] })), agentGroupsList: vi.fn(async () => ({ groups: [] })),
  retentionGlobalGet: vi.fn(async () => ({ keylog_days: 7, window_days: 7, url_days: 7 })), storageUsage: vi.fn(async () => ({})),
  agentAutoUpdateGlobalGet: vi.fn(async () => ({ enabled: true })),
  settingsVersionGet: vi.fn(async () => ({ latest_server_release: null, releases_url: "https://example.com/releases" })),
  listAgentEnrollmentTokens: vi.fn(async () => ({ tokens: [] })), listAgentEnrollmentClaims: vi.fn(async () => ({ claims: [] })),
  urlCategorizationStatusGet: vi.fn(async () => ({ settings: {}, job: { state: "idle" } })),
  // Historical server values must never be fetched or claimed as current device state.
  localUiPasswordAgentGet: vi.fn(async () => ({ global: { password_set: true }, override: { password_set: true } })),
  localUiPasswordGlobalGet: vi.fn(async () => ({ password_set: true })),
  localUiPasswordAgentPut: vi.fn(), localUiPasswordAgentDelete: vi.fn(), localUiPasswordGlobalPut: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/serverVersionStore", () => ({ useServerVersionPayload: () => null }));
vi.mock("@/components/AgentModuleSettings", () => ({ AgentModuleSettings: () => <div>Module controls</div> }));
vi.mock("@/components/AgentReplacementSettings", () => ({ AgentReplacementSettings: () => <div>Replace installation</div> }));
vi.mock("@/components/recall/AgentRecallSettings", () => ({ AgentRecallSettings: () => <div>Recall settings</div> }));
vi.mock("./AgentEnrollmentSettings", () => ({ AgentEnrollmentSettings: () => <div>Enrollment settings</div> }));
vi.mock("./DataRetentionSettings", () => ({ DataRetentionSettings: () => <div>Retention settings</div> }));
vi.mock("./RecallCaptureSettings", () => ({ RecallCaptureSettings: () => <div>Recall settings</div> }));
vi.mock("./UrlCategorizationSettings", () => ({ UrlCategorizationSettings: () => <div>URL settings</div> }));
vi.mock("./BrowserPushToggle", () => ({ BrowserPushToggle: () => null }));
vi.mock("./NotificationsSettings", () => ({ NotificationsSettings: () => null }));
vi.mock("./SystemAboutSettings", () => ({ SystemAboutSettings: () => <div>System settings</div> }));
const roots: Root[] = [];
async function render(content: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement("div"); const root = createRoot(element); roots.push(root);
  await act(async () => root.render(content)); return element;
}
async function tab(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
function guidance(element: HTMLElement) {
  expect(element.textContent).toContain("local settings on the device");
  expect(element.textContent).toContain("enabling a module requires consent on the device");
  expect(element.textContent).toContain("Previously stored server");
  expect(element.querySelector('input[type="password"]')).toBeNull();
  for (const text of ["Password is set", "No password —", "Save override", "Remove password"]) expect(element.textContent).not.toContain(text);
}
function noPolicyCalls() {
  for (const method of [api.localUiPasswordAgentGet, api.localUiPasswordGlobalGet, api.localUiPasswordAgentPut, api.localUiPasswordAgentDelete, api.localUiPasswordGlobalPut]) expect(method).not.toHaveBeenCalled();
}
afterEach(async () => {for (const root of roots.splice(0)) await act(async () => root.unmount()); vi.clearAllMocks();});
describe("on-device password and consent guidance", () => {
  it("provides guidance without password inputs or action buttons", async () => {
    const element = await render(<SecuritySettings />); guidance(element); expect(element.querySelector("button")).toBeNull();
  });
  it("removes per-device policy reads and controls while preserving other settings", async () => {
    const element = await render(<AgentSettingsTab agentId="device" agentName="Office PC" agentOnline agentVersion="1.0" isAdmin dashboardRole="admin" />);
    await tab(element, "Security"); guidance(element); noPolicyCalls();
    expect(api.retentionAgentGet).toHaveBeenCalledWith("device"); expect(api.agentIconGet).toHaveBeenCalledWith("device"); expect(api.agentAutoUpdateAgentGet).toHaveBeenCalledWith("device");
    await tab(element, "General"); expect(element.textContent).toContain("Replace installation");
    await tab(element, "Modules"); expect(element.textContent).toContain("Module controls");
    await tab(element, "Recall"); expect(element.textContent).toContain("Recall settings");
    await tab(element, "Updates"); expect(element.textContent).toContain("Auto updates");
  });
  it("removes the global policy fetch and form while retaining metadata loads", async () => {
    const admin = { id: "admin", username: "admin", role: "admin", display_name: "Admin", display_icon: null } as const;
    const session: SessionContextValue = {
      authenticated: true, user: admin, navUser: admin,
      refresh: async () => {}, completeLogin: () => {}, logout: async () => {},
    };
    const element = await render(<SessionContext.Provider value={session}><SettingsPage /></SessionContext.Provider>);
    guidance(element); noPolicyCalls(); expect(api.retentionGlobalGet).toHaveBeenCalled(); expect(api.agentAutoUpdateGlobalGet).toHaveBeenCalled();
    expect(element.textContent).toContain("Enrollment settings"); expect(element.textContent).toContain("Retention settings");
  });
});
