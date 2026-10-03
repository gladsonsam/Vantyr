// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { AgentReplacementSettings } from "./AgentReplacementSettings";

vi.mock("../lib/api", () => ({ api: { createAgentEnrollmentToken: vi.fn(), revokeAgentEnrollmentToken: vi.fn() } }));
vi.mock("./ui/console", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Alert: Wrapper, Container: Wrapper, Header: Wrapper, SpaceBetween: Wrapper,
    Button: ({ children, onClick, disabled, loading }: { children: ReactNode; onClick: () => void; disabled?: boolean; loading?: boolean }) => <button disabled={disabled || loading} onClick={onClick}>{children}</button>,
    Modal: ({ visible, children, footer }: { visible: boolean; children: ReactNode; footer: ReactNode }) => visible ? <div>{children}{footer}</div> : null,
  };
});

afterEach(() => vi.clearAllMocks());

describe("replacement enrollment", () => {
  async function requestCode() {
    const element = document.createElement("div");
    const root = createRoot(element);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await act(async () => root.render(<AgentReplacementSettings agentId="device-uuid" agentName="Original" />));
    await act(async () => element.querySelector("button")!.click());
    const confirm = [...element.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Revoke credential"))!;
    await act(async () => confirm.click());
    return { root, element };
  }

  it("requests an explicitly bound code and explains preserved identity", async () => {
    vi.mocked(api.createAgentEnrollmentToken).mockResolvedValue({ id: "invite", enrollment_token: "123456", uses: 1, expires_at: "2026-10-03T12:00:00Z", bound_agent_id: "device-uuid" } as Awaited<ReturnType<typeof api.createAgentEnrollmentToken>>);
    const { root, element } = await requestCode();
    expect(api.createAgentEnrollmentToken).toHaveBeenCalledWith({ uses: 1, bound_agent_id: "device-uuid" });
    expect(element.textContent).toContain("123456");
    expect(element.textContent).toContain("preserves this device’s UUID and name");
    expect(api.revokeAgentEnrollmentToken).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("revokes a generic code from an older server and never displays it as a replacement", async () => {
    vi.mocked(api.createAgentEnrollmentToken).mockResolvedValue({ id: "generic", enrollment_token: "654321", uses: 1, expires_at: null });
    vi.mocked(api.revokeAgentEnrollmentToken).mockResolvedValue({ ok: true });
    const { root, element } = await requestCode();
    expect(api.revokeAgentEnrollmentToken).toHaveBeenCalledWith("generic");
    expect(element.textContent).not.toContain("654321");
    expect(element.textContent).toContain("server does not support device replacement");
    await act(async () => root.unmount());
  });
});
