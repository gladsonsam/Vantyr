// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { buttonByText, byLabel, click, typeInto } from "@tests/support/formDom";
import { ApiError } from "@/api";
import { TwoFactorSettings } from "@/features/auth/TwoFactorSettings";

const api = vi.hoisted(() => ({
  twofaStatus: vi.fn(),
  twofaSetup: vi.fn(),
  twofaEnable: vi.fn(),
  twofaDisable: vi.fn(),
}));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api }));
vi.mock("@/lib/utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/utils")>()), copyToClipboard: vi.fn(async () => true) }));

const SECRET = "JBSWY3DPEHPK3PXP";
const setupReply = { secret: SECRET, otpauth_uri: `otpauth://totp/Vantyr:demo?secret=${SECRET}` };
const CODES = ["abcd-efgh", "jkmn-pqrs", "tuvw-xy23"];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.twofaStatus.mockResolvedValue({ enabled: false, pending: false });
  api.twofaSetup.mockResolvedValue(setupReply);
  api.twofaEnable.mockResolvedValue({ ok: true, recovery_codes: CODES });
  api.twofaDisable.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(withQueryClient(<TwoFactorSettings />, createTestQueryClient())));
}
const hasButton = (text: string) => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === text);
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? "");

describe("TwoFactorSettings", () => {
  it("shows the status and offers setup when it is off", async () => {
    await render();
    expect(host.textContent).toContain("Not enabled");
    expect(host.textContent).toContain("Signing in uses only your password.");
    expect(buttonByText("Set up 2FA").disabled).toBe(false);
  });

  it("never presents a failed status load as \"Not enabled\" or offers setup; Try again recovers", async () => {
    api.twofaStatus.mockRejectedValueOnce(new ApiError("Service unavailable", 503)).mockResolvedValue({ enabled: true, pending: false });
    await render();
    expect(alerts()[0]).toContain("Couldn’t load your two-factor status: Service unavailable");
    expect(host.textContent).not.toContain("Not enabled");
    expect(hasButton("Set up 2FA")).toBe(false);
    await click(buttonByText("Try again"));
    expect(host.textContent).toContain("Enabled");
    expect(alerts()).toEqual([]);
  });

  it("keeps the last known status and says it may be stale when a refresh fails", async () => {
    const client = createTestQueryClient();
    await act(async () => root.render(withQueryClient(<TwoFactorSettings />, client)));
    api.twofaStatus.mockRejectedValue(new ApiError("offline", 0));
    await act(async () => { await client.refetchQueries({ queryKey: ["auth", "2fa-status"] }).catch(() => undefined); });
    expect(host.textContent).toContain("Not enabled");
    expect(alerts()[0]).toContain("Couldn’t refresh your two-factor status");
  });

  it("walks through setup: key with copy, 6-digit code, then recovery codes with the code box turning into the disable form", async () => {
    await render();
    await click(buttonByText("Set up 2FA"));
    expect(host.textContent).toContain(SECRET);
    expect(hasButton("Copy key")).toBe(true);
    expect(host.querySelector<HTMLAnchorElement>("a")!.getAttribute("href")).toBe(setupReply.otpauth_uri);
    // The long otpauth URI is behind the link, not printed next to the key.
    expect(host.textContent).not.toContain("otpauth://");
    expect(document.activeElement?.textContent).toBe("Add this key to your authenticator app");

    const code = byLabel("Enter the 6-digit code to confirm");
    expect(code.inputMode).toBe("numeric");
    await typeInto(code, "123456");
    await click(buttonByText("Enable 2FA"));
    expect(api.twofaEnable).toHaveBeenCalledWith("123456");
    for (const c of CODES) expect(host.textContent).toContain(c);
    expect(hasButton("Copy codes")).toBe(true);
    expect(host.textContent).toContain("Enabled");
    expect(host.textContent).not.toContain(SECRET);
    expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("twofa-recovery-title");
    expect(buttonByText("Disable 2FA")).toBeTruthy();
  });

  it("puts a refused enrollment code next to the box, keeps setup open and selects the code", async () => {
    api.twofaEnable.mockRejectedValue(new ApiError("Invalid code", 400));
    await render();
    await click(buttonByText("Set up 2FA"));
    await typeInto(byLabel("Enter the 6-digit code to confirm"), "000000");
    await click(buttonByText("Enable 2FA"));
    await vi.waitFor(() => expect(alerts()).toEqual(["Invalid code"]));
    expect(host.textContent).toContain(SECRET);
    // Focus returns once the box is enabled again (the request has finished).
    await vi.waitFor(() => expect(document.activeElement).toBe(byLabel("Enter the 6-digit code to confirm")));
  });

  it("lets Cancel setup throw the secret away and returns focus to the status", async () => {
    await render();
    await click(buttonByText("Set up 2FA"));
    await click(buttonByText("Cancel setup"));
    expect(host.textContent).not.toContain(SECRET);
    expect(buttonByText("Set up 2FA")).toBeTruthy();
    expect(document.activeElement?.textContent).toContain("Not enabled");
  });

  it("reports a failed setup start at the Set up button and keeps it available", async () => {
    api.twofaSetup.mockRejectedValue(new ApiError("Try later", 500));
    await render();
    await click(buttonByText("Set up 2FA"));
    expect(alerts()).toEqual(["Try later"]);
    expect(buttonByText("Set up 2FA").disabled).toBe(false);
  });

  it("hides recovery codes only when the person says they saved them, then focuses the status", async () => {
    await render();
    await click(buttonByText("Set up 2FA"));
    await typeInto(byLabel("Enter the 6-digit code to confirm"), "123456");
    await click(buttonByText("Enable 2FA"));
    await click(buttonByText("I’ve saved them"));
    expect(host.textContent).not.toContain(CODES[0]);
    expect(document.activeElement?.textContent).toContain("Enabled");
  });

  it("turns 2FA off with a code (letters allowed for recovery codes) and shows failures inside the form", async () => {
    api.twofaStatus.mockResolvedValue({ enabled: true, pending: false });
    api.twofaDisable.mockRejectedValueOnce(new ApiError("Wrong code", 401)).mockResolvedValue({ ok: true });
    await render();
    const box = byLabel("Code to turn off two-factor authentication");
    expect(box.inputMode).toBe("text");
    expect(host.textContent).toContain("Enter a current authenticator code, or a recovery code.");
    await typeInto(box, "abcd-efgh");
    await click(buttonByText("Disable 2FA"));
    expect(alerts()).toEqual(["Wrong code"]);
    await click(buttonByText("Disable 2FA"));
    expect(api.twofaDisable).toHaveBeenLastCalledWith("abcd-efgh");
    expect(host.textContent).toContain("Not enabled");
    expect(document.activeElement?.textContent).toContain("Not enabled");
  });
});
