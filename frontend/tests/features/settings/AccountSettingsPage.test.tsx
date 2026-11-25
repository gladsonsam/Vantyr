// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click } from "@tests/support/formDom";
import { AppearanceSettings } from "@/features/settings/AppearanceSettings";
import { AccountSettingsPage } from "@/features/settings/AccountSettingsPage";

const api = vi.hoisted(() => ({ twofaStatus: vi.fn() }));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api }));
const changeTheme = vi.fn();
vi.mock("@/app/providers/useAppTheme", () => ({ useAppTheme: () => ({ themeMode: "dark", changeTheme }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  api.twofaStatus.mockResolvedValue({ enabled: false, pending: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const option = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group-item"]')].find((b) => b.textContent?.trim() === name)!;

describe("AppearanceSettings", () => {
  it("marks the current theme and switches with one press", async () => {
    const onThemeChange = vi.fn();
    await act(async () => root.render(<AppearanceSettings themeMode="dark" onThemeChange={onThemeChange} />));
    expect(host.querySelector('[role="group"][aria-label="Theme"]')).toBeTruthy();
    expect(option("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(option("Light").getAttribute("aria-pressed")).toBe("false");
    await click(option("Light"));
    expect(onThemeChange).toHaveBeenCalledWith("light");
  });

  it("never deselects: pressing the chosen theme again changes nothing", async () => {
    const onThemeChange = vi.fn();
    await act(async () => root.render(<AppearanceSettings themeMode="system" onThemeChange={onThemeChange} />));
    await click(option("System"));
    expect(onThemeChange).not.toHaveBeenCalled();
  });
});

describe("AccountSettingsPage", () => {
  it("holds only your own settings and points to the server Settings page for the rest", async () => {
    await act(async () => root.render(
      withQueryClient(<MemoryRouter><AccountSettingsPage /></MemoryRouter>, createTestQueryClient()),
    ));
    const text = host.textContent ?? "";
    expect(text).toContain("Appearance");
    expect(text).toContain("Two-factor authentication");
    expect(host.querySelector<HTMLAnchorElement>('a[href="/settings"]')?.textContent).toBe("Settings");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Back")).toBe(true);
  });
});
