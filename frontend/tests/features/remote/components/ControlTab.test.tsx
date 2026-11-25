// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { click, mountForm, unmountForms } from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { ControlTab } from "@/features/remote/components/ControlTab";

const backend = vi.hoisted(() => ({
  agentInternetBlockedGet: vi.fn(),
  agentInternetBlockedPut: vi.fn(),
  appBlockRulesList: vi.fn(),
  appBlockRulesUpdate: vi.fn(),
  appBlockRulesDelete: vi.fn(),
}));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api: backend }));

const rule = (id: number, over: Record<string, unknown> = {}) => ({
  id, name: `Rule ${id}`, exe_pattern: `app${id}.exe`, match_mode: "exact", enabled: true, scope_kind: "agent", ...over,
});

beforeEach(() => {
  backend.agentInternetBlockedGet.mockReset().mockResolvedValue({ blocked: false, source: null });
  backend.agentInternetBlockedPut.mockReset();
  backend.appBlockRulesList.mockReset().mockResolvedValue({ rules: [rule(1), rule(2, { enabled: false }), rule(3, { scope_kind: "all" })] });
  backend.appBlockRulesUpdate.mockReset().mockResolvedValue({ ok: true });
  backend.appBlockRulesDelete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(unmountForms);

const text = () => document.body.textContent ?? "";
const settle = () => act(async () => {});
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) as HTMLButtonElement | undefined;

async function mount(props: Partial<React.ComponentProps<typeof ControlTab>> = {}) {
  await mountForm(withQueryClient(
    <MemoryRouter>
      <ControlTab agentId="a1" agentName="Front desk" agentOnline isAdmin sendWsMessage={() => {}} {...props} />
    </MemoryRouter>,
  ));
  await settle();
  await settle();
}

describe("ControlTab", () => {
  it("is for admins only", async () => {
    await mount({ isAdmin: false });
    expect(text()).toContain("Admin only.");
    expect(button("Block internet")).toBeUndefined();
  });

  it("states the current policy and offers only the opposite action", async () => {
    await mount();
    expect(text()).toContain("Internet is allowed");
    expect(button("Block internet")).toBeDefined();
    expect(button("Allow internet")).toBeUndefined();
    expect(text()).toContain("3 rules · 2 on");
  });

  it("asks before blocking, says what happens, and only shows 'blocked' after the server replied", async () => {
    let reply: (v: unknown) => void = () => {};
    backend.agentInternetBlockedPut.mockReturnValue(new Promise((resolve) => { reply = resolve; }));
    await mount();
    await click(button("Block internet")!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Block internet on Front desk?");
    expect(dialog.textContent).toContain("except its connection to Vantyr");
    expect(backend.agentInternetBlockedPut).not.toHaveBeenCalled();

    await click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent?.includes("Block internet"))!);
    expect(backend.agentInternetBlockedPut).toHaveBeenCalledWith("a1", { blocked: true });
    expect(text()).toContain("Internet is allowed");

    await act(async () => reply({ blocked: true, source: "agent" }));
    await settle();
    expect(text()).toContain("Internet is blocked");
    expect(button("Allow internet")).toBeDefined();
  });

  it("cancelling the block changes nothing", async () => {
    await mount();
    await click(button("Block internet")!);
    await click(button("Cancel")!);
    expect(backend.agentInternetBlockedPut).not.toHaveBeenCalled();
    expect(text()).toContain("Internet is allowed");
  });

  it("allows internet again without a confirmation", async () => {
    backend.agentInternetBlockedGet.mockResolvedValue({ blocked: true, source: "agent" });
    backend.agentInternetBlockedPut.mockResolvedValue({ blocked: false, source: null });
    await mount();
    expect(text()).toContain("Internet is blocked");
    await click(button("Allow internet")!);
    await settle();
    expect(backend.agentInternetBlockedPut).toHaveBeenCalledWith("a1", { blocked: false });
    expect(text()).toContain("Internet is allowed");
  });

  it("explains a block set elsewhere instead of offering an action that cannot work", async () => {
    backend.agentInternetBlockedGet.mockResolvedValue({ blocked: true, source: "group" });
    await mount();
    expect(text()).toContain("Set by a group rule");
    expect(button("Allow internet")).toBeUndefined();
    expect(Array.from(document.querySelectorAll("a")).some((a) => a.getAttribute("href") === "/rules?tab=internet-access")).toBe(true);
  });

  it("does not read a failed status load as 'allowed'", async () => {
    backend.agentInternetBlockedGet.mockRejectedValueOnce(new Error("boom"));
    await mount();
    expect(text()).toContain("Internet status unknown");
    expect(button("Block internet")).toBeUndefined();
    await click(button("Try again")!);
    await settle();
    expect(text()).toContain("Internet is allowed");
  });

  it("shows a failed change and keeps the previous state", async () => {
    backend.agentInternetBlockedPut.mockRejectedValue(new Error("Agent is busy"));
    await mount();
    await click(button("Block internet")!);
    await click(Array.from(document.querySelector('[role="alertdialog"]')!.querySelectorAll("button")).find((b) => b.textContent?.includes("Block internet"))!);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Agent is busy");
    expect(text()).toContain("Internet is allowed");
  });

  it("notes an offline device and a capability the device lacks", async () => {
    await mount({ agentOnline: false, agentInfo: { capabilities: { network_blocking: "needs_privilege", app_blocking: "unsupported" } } as never });
    expect(text()).toContain("Device offline. Changes apply when it reconnects.");
    expect(text()).toContain("administrator rights");
    expect(text()).toContain("App blocking isn’t available on this device (unsupported)");
    expect(button("Add rule")!.disabled).toBe(true);
  });

  it("toggles a rule and updates the count only after the server confirms", async () => {
    await mount();
    const sw = document.querySelector('[aria-label="app2.exe: block this app"]') as HTMLElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await click(sw);
    await settle();
    expect(backend.appBlockRulesUpdate).toHaveBeenCalledWith(2, { enabled: true });
    expect(text()).toContain("3 rules · all on");
  });

  it("names where a shared rule stops when deleting it, and deletes only after confirmation", async () => {
    await mount();
    expect(document.querySelector('[aria-label="app3.exe (all devices): block this app"]')).not.toBeNull();
    await click(button("Delete rule for app3.exe")!);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("every device, not just this one");
    expect(backend.appBlockRulesDelete).not.toHaveBeenCalled();
    await click(button("Delete")!);
    await settle();
    expect(backend.appBlockRulesDelete).toHaveBeenCalledWith(3);
    expect(text()).toContain("2 rules · 1 on");
  });

  it("reports a failed rules load with a retry", async () => {
    backend.appBlockRulesList.mockRejectedValueOnce(new Error("rules down"));
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("rules down");
    await click(button("Try again")!);
    await settle();
    expect(text()).toContain("3 rules");
  });
});
