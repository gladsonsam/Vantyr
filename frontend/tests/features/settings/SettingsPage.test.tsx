// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click, mountForm, unmountForms } from "@tests/support/formDom";
import { SessionContext, type SessionContextValue } from "@/app/providers/useSession";
import { SettingsPage } from "@/features/settings/SettingsPage";

const api = vi.hoisted(() => ({
  retentionGlobalGet: vi.fn(async () => ({ keylog_days: 7, window_days: 7, url_days: 7 })),
  storageUsage: vi.fn(async () => ({ database_bytes: 1, public_tables_bytes: 1, other_bytes: 0, tables: [] })),
  agentAutoUpdateGlobalGet: vi.fn(async () => ({ enabled: true })),
  settingsVersionGet: vi.fn(async () => ({ server_version: "1", latest_server_release: "1", server_update_available: false, latest_agent_version: "1", releases_url: "" })),
  listAgentEnrollmentTokens: vi.fn(async () => ({ tokens: [] })),
  listAgentEnrollmentClaims: vi.fn(async () => ({ claims: [] })),
  urlCategorizationStatusGet: vi.fn(async () => ({ settings: {}, job: { state: "idle" } })),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e) }));
vi.mock("@/features/enrollment/AgentEnrollmentSettings", () => ({ AgentEnrollmentSettings: () => <div>Enrollment panel</div> }));
vi.mock("@/features/recall/components/RecallCaptureSettings", () => ({ RecallCaptureSettings: () => <div>Capture panel</div> }));
vi.mock("@/features/settings/UrlCategorizationSettings", () => ({ UrlCategorizationSettings: () => <div>URL panel</div> }));
vi.mock("@/features/settings/BrowserPushToggle", () => ({ BrowserPushToggle: () => <div>Push panel</div> }));
vi.mock("@/features/settings/NotificationsSettings", () => ({ NotificationsSettings: () => <div>Channels panel</div> }));

const session = (role: "admin" | "viewer"): SessionContextValue => {
  const user = { id: "u", username: "u", role, display_name: "U", display_icon: null, csrf_token: "c" } as const;
  return { authenticated: true, user, navUser: user, refresh: async () => {}, completeLogin: () => {}, logout: async () => {} };
};

function Probe() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}${l.search}`}</output>;
}
const location = () => document.querySelector('[data-testid="location"]')?.textContent;

const render = (entry: string, role: "admin" | "viewer" = "admin") =>
  mountForm(withQueryClient(
    <MemoryRouter initialEntries={[entry]}>
      <SessionContext.Provider value={session(role)}><SettingsPage /><Probe /></SessionContext.Provider>
    </MemoryRouter>,
    createTestQueryClient(),
  ));
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const selected = () => tabs().filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent);

beforeEach(() => vi.clearAllMocks());
afterEach(unmountForms);

describe("Settings wayfinding", () => {
  it("names the four sections and opens on Agents with a line saying what is inside", async () => {
    await render("/settings");
    expect(tabs().map((t) => t.textContent)).toEqual(["Agents", "Data", "Alerts", "System"]);
    expect(selected()).toEqual(["Agents"]);
    expect(document.body.textContent).toContain("Enroll new devices and approve the ones waiting.");
  });

  it("opens the section named in the address and falls back to Agents for an unknown one", async () => {
    await render("/settings?section=alerts");
    expect(selected()).toEqual(["Alerts"]);
    expect(document.body.textContent).toContain("Where alert matches are sent");
    unmountForms();
    await render("/settings?section=nope");
    expect(selected()).toEqual(["Agents"]);
  });

  it("writes the chosen section into the address without piling up history", async () => {
    await render("/settings");
    await click(tabs().find((t) => t.textContent === "System")!);
    expect(location()).toBe("/settings?section=system");
    expect(selected()).toEqual(["System"]);
    expect(document.body.textContent).toContain("Version, updates and storage.");
  });

  it("keeps every panel mounted so a half-edited form survives switching sections", async () => {
    await render("/settings?section=data");
    for (const panel of ["Enrollment panel", "Capture panel", "URL panel", "Channels panel", "Push panel", "Server version", "Storage usage"]) {
      expect(document.body.textContent).toContain(panel);
    }
  });

  it("tells people who are not admins once, at the top, that these are view-only", async () => {
    await render("/settings?section=data", "viewer");
    expect(document.body.textContent).toContain("You can view these settings; only admins can change them.");
    await act(async () => {});
    unmountForms();
    await render("/settings?section=data", "admin");
    expect(document.body.textContent).not.toContain("only admins can change them");
  });
});
