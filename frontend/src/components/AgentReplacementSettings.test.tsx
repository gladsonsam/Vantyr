// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { AgentReplacementSettings } from "./AgentReplacementSettings";

vi.mock("../lib/api", () => ({ api: { createAgentEnrollmentToken: vi.fn(), revokeAgentEnrollmentToken: vi.fn() } }));

let host: HTMLDivElement;
let root: Root;

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentReplacementSettings agentId="device-uuid" agentName="Original" />));
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("replacement enrollment", () => {
  async function requestCode() {
    await render();
    const trigger = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Replace installation / Re-enroll"),
    )!;
    await act(async () => trigger.click());
    // The confirmation dialog portals to document.body.
    const confirm = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Revoke credential"),
    )!;
    await act(async () => confirm.click());
    return host;
  }

  it("requests an explicitly bound code and explains preserved identity", async () => {
    vi.mocked(api.createAgentEnrollmentToken).mockResolvedValue({ id: "invite", enrollment_token: "123456", uses: 1, expires_at: "2026-10-03T12:00:00Z", bound_agent_id: "device-uuid" } as Awaited<ReturnType<typeof api.createAgentEnrollmentToken>>);
    const element = await requestCode();
    expect(api.createAgentEnrollmentToken).toHaveBeenCalledWith({ uses: 1, bound_agent_id: "device-uuid" });
    expect(element.textContent).toContain("123456");
    expect(element.textContent).toContain("preserves this device’s UUID and name");
    expect(api.revokeAgentEnrollmentToken).not.toHaveBeenCalled();
  });

  it("revokes a generic code from an older server and never displays it as a replacement", async () => {
    vi.mocked(api.createAgentEnrollmentToken).mockResolvedValue({ id: "generic", enrollment_token: "654321", uses: 1, expires_at: null });
    vi.mocked(api.revokeAgentEnrollmentToken).mockResolvedValue({ ok: true });
    const element = await requestCode();
    expect(api.revokeAgentEnrollmentToken).toHaveBeenCalledWith("generic");
    // The failure surfaces inside the confirmation dialog, which portals to
    // document.body — it must never appear as a usable replacement code.
    expect(element.textContent).not.toContain("654321");
    expect(document.body.textContent).not.toContain("654321");
    expect(document.body.textContent).toContain("server does not support device replacement");
  });
});
