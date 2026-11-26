import { buttonByText, byLabel, click, typeInto } from "@tests/support/formDom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const sso = (() => ({ canAutoRedirectToSso: vi.fn(() => true), redirectToSso: vi.fn() }))();
await vi.mock("@/features/auth/sso", () => sso);
const api = (() => ({ login: vi.fn(), authConfig: vi.fn() }))();
const originalModule0 = await import("@/api");
await vi.mock("@/api", async () => ({ ...originalModule0, api }));

const { ApiError } = await import("@/api");
const { LoginPage } = await import("@/features/auth/LoginPage");

let host: HTMLDivElement;
let root: Root;
const onLoginSuccess = vi.fn();
let consoleError: { mockRestore: () => void };

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  api.authConfig.mockResolvedValue({ oidc_enabled: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      withQueryClient(<LoginPage onLoginSuccess={onLoginSuccess} />, createTestQueryClient()),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  consoleError.mockRestore();
});

const fill = async (user: string, password: string) => {
  await typeInto(byLabel("Username"), user);
  await typeInto(byLabel("Password"), password);
};
const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? "");

describe("LoginPage", () => {
  it("keeps Sign in disabled until both fields are filled, and has no placeholder repeating the labels", async () => {
    expect(buttonByText("Sign in").disabled).toBe(true);
    expect(byLabel("Username").placeholder).toBe("");
    await fill("ada", "secret");
    expect(buttonByText("Sign in").disabled).toBe(false);
  });

  it("signs in with the typed credentials and no code", async () => {
    api.login.mockResolvedValue(undefined);
    await fill("ada", "secret");
    await click(buttonByText("Sign in"));
    expect(api.login).toHaveBeenCalledWith("ada", "secret", undefined);
    expect(onLoginSuccess).toHaveBeenCalledTimes(1);
  });

  it("shows the failure, keeps what was typed and selects the password for retyping", async () => {
    api.login.mockRejectedValue(
      new ApiError("Invalid credentials.", 401, {
        error: "Invalid credentials.",
        attempts_remaining: 3,
      }),
    );
    await fill("ada", "wrong");
    await click(buttonByText("Sign in"));
    expect(alerts()[0]).toContain("Invalid credentials. 3 attempts remaining before lockout.");
    expect(byLabel("Username").value).toBe("ada");
    expect(byLabel("Password").value).toBe("wrong");
    expect(onLoginSuccess).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byLabel("Password"));
  });

  it("asks for the authenticator code without an error, then sends it with the same credentials", async () => {
    api.login
      .mockRejectedValueOnce(
        new ApiError("Code required", 401, { totp_required: true, error: "Code required" }),
      )
      .mockResolvedValueOnce(undefined);
    await fill("ada", "secret");
    await click(buttonByText("Sign in"));
    expect(alerts()).toEqual([]);
    expect(host.textContent).toContain("Two-step verification");
    const code = byLabel("Authenticator code");
    expect(document.activeElement).toBe(code);
    expect(buttonByText("Sign in").disabled).toBe(true);
    await typeInto(code, " 123456 ");
    await click(buttonByText("Sign in"));
    expect(api.login).toHaveBeenLastCalledWith("ada", "secret", "123456");
    expect(onLoginSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows Sign in with Authentik below an "or" only when the server offers single sign-on', async () => {
    expect(
      [...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Authentik")),
    ).toBe(false);
    api.authConfig.mockResolvedValue({ oidc_enabled: true });
    await act(async () =>
      root.render(
        withQueryClient(
          <LoginPage onLoginSuccess={onLoginSuccess} key="sso" />,
          createTestQueryClient(),
        ),
      ),
    );
    expect(buttonByText("Sign in with Authentik")).toBeTruthy();
    expect(host.textContent).toContain("or");
  });

  it("tells a screen reader it is busy and blocks a second submit while signing in", async () => {
    let finish: () => void = () => {};
    api.login.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await fill("ada", "secret");
    await click(buttonByText("Sign in"));
    expect(host.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
    expect(buttonByText("Signing in…").disabled).toBe(true);
    // Fields stay readable and focusable (readOnly) so focus is not thrown away mid-request.
    expect(byLabel("Username").readOnly).toBe(true);
    expect(byLabel("Username").disabled).toBe(false);
    await act(async () => finish());
    expect(api.login).toHaveBeenCalledTimes(1);
  });

  it("shows a busy notice with a manual Continue button while the single sign-on redirect starts", async () => {
    api.authConfig.mockResolvedValue({ oidc_enabled: true, oidc_auto_login: true });
    await act(async () =>
      root.render(
        withQueryClient(
          <LoginPage onLoginSuccess={onLoginSuccess} key="auto" />,
          createTestQueryClient(),
        ),
      ),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Redirecting to single sign-on…",
    );
    expect(buttonByText("Continue to SSO")).toBeTruthy();
    expect(host.querySelector("form")).toBeNull();
    expect(sso.redirectToSso).toHaveBeenCalledTimes(1);
  });
});
