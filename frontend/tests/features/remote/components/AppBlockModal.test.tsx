import {
  buttonByText,
  byLabel,
  click,
  mountForm,
  typeInto,
  unmountForms,
} from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { afterEach, describe, expect, it } from "bun:test";

const api = (() => ({
  agentKnownExes: vi.fn(async () => ({ exes: [] })),
  appBlockProtectedExes: vi.fn(async () => ({ protected: ["explorer.exe"] })),
  appBlockRulesCreate: vi.fn<(body: unknown) => Promise<{ id: number }>>(async () => ({ id: 1 })),
  // AppIcon asks for icons.
  agentAppIcon: vi.fn(async () => null),
}))();
await vi.mock("@/api", () => ({ api }));
await vi.mock("@/components/common/AppIcon", () => ({ AppIcon: () => null }));

const { AppBlockModal } = await import("@/features/remote/components/AppBlockModal");

afterEach(() => {
  unmountForms();
  vi.clearAllMocks();
});

async function open() {
  const onCreated = vi.fn();
  const onDismiss = vi.fn();
  await mountForm(
    withQueryClient(
      <AppBlockModal
        visible
        agentId="a1"
        agentName="PC"
        onDismiss={onDismiss}
        onCreated={onCreated}
      />,
    ),
  );
  // let the protected-exes query settle
  await act(async () => {
    await Promise.resolve();
  });
  return { onCreated, onDismiss };
}

const alertText = () => document.querySelector('p[role="alert"]')?.textContent ?? null;

describe("AppBlockModal", () => {
  it("reports 'EXE name is required.' above the form and does not create", async () => {
    await open();
    await click(buttonByText("Add rule"));
    expect(alertText()).toBe("EXE name is required.");
    expect(api.appBlockRulesCreate).not.toHaveBeenCalled();
  });

  it("flags a protected executable as typed and disables Add rule", async () => {
    await open();
    await typeInto(byLabel("EXE name"), "explorer.exe");
    expect(alertText()).toBe("'explorer.exe' is protected and can't be blocked.");
    expect(buttonByText("Add rule").disabled).toBe(true);
  });

  it("creates a device-scoped rule labelled with the exe and closes", async () => {
    const { onCreated, onDismiss } = await open();
    await typeInto(byLabel("EXE name"), "tiktok.exe");
    await click(buttonByText("Add rule"));
    expect(api.appBlockRulesCreate).toHaveBeenCalledWith({
      name: "tiktok.exe",
      exe_pattern: "tiktok.exe",
      match_mode: "contains",
      scopes: [{ kind: "agent", agent_id: "a1" }],
      schedules: undefined,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
