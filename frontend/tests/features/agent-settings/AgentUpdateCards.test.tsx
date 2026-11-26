import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const api = (() => ({
  agentUpdateNow: vi.fn(),
  agentAutoUpdateAgentGet: vi.fn(),
  agentAutoUpdateAgentPut: vi.fn(),
  agentAutoUpdateAgentDelete: vi.fn(),
}))();
await vi.mock("@/api", () => ({
  api,
  errorText: (e: unknown) => String(e instanceof Error ? e.message : e),
}));
const latest = (() => ({ value: "0.2.9" as string | null }))();
await vi.mock("@/api/serverVersionStore", () => ({
  useServerVersionPayload: () => ({ latest_agent_version: latest.value }),
}));

const { AgentAutoUpdateCard, AgentUpdateCard } =
  await import("@/features/agent-settings/AgentUpdateCards");

beforeEach(() => {
  vi.clearAllMocks();
  latest.value = "0.2.9";
});
afterEach(unmountForms);

type VersionProps = { agentOnline?: boolean; agentVersion?: string | null; isAdmin?: boolean };
const node = ({ agentOnline = true, agentVersion = "0.1.6", isAdmin = true }: VersionProps) => (
  <AgentUpdateCard
    agentId="device"
    agentOnline={agentOnline}
    agentVersion={agentVersion}
    isAdmin={isAdmin}
  />
);
const client = createTestQueryClient();
const renderVersion = (props: VersionProps = {}) => mountForm(withQueryClient(node(props), client));
const toggle = (name: string) =>
  [...document.querySelectorAll('[role="group"] button')].find((b) =>
    b.textContent?.startsWith(name),
  ) as HTMLButtonElement;

describe("agent version card", () => {
  it("separates installed from latest and offers the update only when one exists", async () => {
    await renderVersion();
    expect(document.body.textContent).toContain("Installedv0.1.6");
    expect(document.body.textContent).toContain("Latestv0.2.9");
    expect(document.body.textContent).toContain("A newer version is available");
    expect(buttonByText("Update now")).toBeTruthy();
  });

  it("does not claim up to date when a version is unknown", async () => {
    latest.value = null;
    await renderVersion();
    expect(document.body.textContent).toContain("The latest version is unknown");
    expect(document.body.textContent).not.toContain("Up to date");
    expect(document.body.textContent).not.toContain("Update now");
  });

  it("says up to date only when installed matches the latest", async () => {
    await renderVersion({ agentVersion: "0.2.9" });
    expect(document.body.textContent).toContain("Up to date");
    expect(document.body.textContent).not.toContain("Update now");
  });

  it("disables the request while offline and hides it from non-admins", async () => {
    await renderVersion({ agentOnline: false });
    expect(buttonByText("Update now").disabled).toBe(true);
    expect(document.body.textContent).toContain("Available when the device is online");
    unmountForms();
    await renderVersion({ isAdmin: false });
    expect(document.body.textContent).not.toContain("Update now");
    expect(document.body.textContent).toContain("Only admins can start an update.");
  });

  it("treats an acknowledged request as pending until the device reports a new version", async () => {
    api.agentUpdateNow.mockResolvedValue({ ok: true });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (props: VersionProps) =>
      act(async () => root.render(withQueryClient(node(props), client)));
    await show({});
    await click(buttonByText("Update now"));
    expect(api.agentUpdateNow).toHaveBeenCalledWith("device");
    expect(document.body.textContent).toContain("Update requested at");
    expect(document.body.textContent).toContain(
      "not finished until the device restarts and reports a new version",
    );
    expect(document.body.textContent).not.toContain("now reports");
    expect(buttonByText("Request again")).toBeTruthy();
    // Still the old version after a refresh: still only a request.
    await show({ agentVersion: "v0.1.6" });
    expect(document.body.textContent).toContain("Update requested at");
    // The device reports a different version: only now is it a result.
    await show({ agentVersion: "0.2.9" });
    expect(document.body.textContent).toContain("The device now reports v0.2.9 (was v0.1.6).");
    expect(document.body.textContent).not.toContain("Update requested at");
    expect(document.body.textContent).toContain("Up to date");
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows a failed request and allows trying again", async () => {
    api.agentUpdateNow.mockRejectedValueOnce(new Error("Agent is not connected"));
    await renderVersion();
    await click(buttonByText("Update now"));
    expect(document.body.textContent).toContain("Agent is not connected");
    expect(document.body.textContent).not.toContain("Update requested at");
    expect(buttonByText("Update now").disabled).toBe(false);
  });
});

describe("automatic updates card", () => {
  const overrideOff = { global: { enabled: true }, override: { enabled: false } };
  const renderAuto = (isAdmin = true) =>
    mountForm(
      withQueryClient(
        <AgentAutoUpdateCard agentId="device" isAdmin={isAdmin} />,
        createTestQueryClient(),
      ),
    );

  it("shows the inherited default and the effective result", async () => {
    api.agentAutoUpdateAgentGet.mockResolvedValue({ global: { enabled: true }, override: null });
    await renderAuto();
    expect(toggle("Server default (on)").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("On: following the server default.");
  });

  it("shows an override against the default and saves On, Off and back to the default", async () => {
    api.agentAutoUpdateAgentGet.mockResolvedValue(overrideOff);
    api.agentAutoUpdateAgentPut.mockResolvedValue({
      global: { enabled: true },
      override: { enabled: true },
    });
    api.agentAutoUpdateAgentDelete.mockResolvedValue({ global: { enabled: true }, override: null });
    await renderAuto();
    expect(toggle("Off").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain(
      "Off: set for this device; the server default is On.",
    );
    await click(toggle("On"));
    expect(api.agentAutoUpdateAgentPut).toHaveBeenCalledWith("device", { enabled: true });
    expect(document.body.textContent).toContain("Saved.");
    await click(toggle("Server default"));
    expect(api.agentAutoUpdateAgentDelete).toHaveBeenCalledWith("device");
  });

  it("does nothing for non-admins, and offers a retry when the load fails", async () => {
    api.agentAutoUpdateAgentGet.mockResolvedValue(overrideOff);
    await renderAuto(false);
    expect(toggle("On").disabled).toBe(true);
    expect(document.body.textContent).toContain("Only admins can change this.");
    unmountForms();
    api.agentAutoUpdateAgentGet.mockRejectedValueOnce(new Error("nope"));
    await renderAuto();
    expect(document.body.textContent).toContain("nope");
    await click(buttonByText("Try again"));
    expect(toggle("Off")).toBeTruthy();
  });

  it("shows a save failure and keeps the saved choice", async () => {
    api.agentAutoUpdateAgentGet.mockResolvedValue(overrideOff);
    api.agentAutoUpdateAgentPut.mockRejectedValue(new Error("admin only"));
    await renderAuto();
    await click(toggle("On"));
    expect(document.body.textContent).toContain("admin only");
    expect(toggle("Off").getAttribute("aria-pressed")).toBe("true");
  });
});
