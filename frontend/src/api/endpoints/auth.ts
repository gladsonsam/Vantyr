import type { DashboardSessionUser } from "@/api/types";
import { get, requestJson, postEmpty, postJsonRes, setDashboardCsrfToken } from "@/api/client";

export const authEndpoints = {
  // ── Auth ──────────────────────────────────────────────────────────────────

  /** Check whether the current session is valid (or no password is set). */
  authStatus: async (): Promise<{
    authenticated: boolean;
    password_required: boolean;
  }> => {
    return requestJson(
      "/auth/status",
      { method: "GET" },
      { allowStatuses: [401] },
    );
  },

  authConfig: (): Promise<{ oidc_enabled: boolean; oidc_auto_login?: boolean }> =>
    get("/auth/config"),

  /** Submit credentials; throws with the server error message on failure.
   *  When the account has 2FA, the first call throws a 401 with `totp_required`;
   *  retry with `totpCode` (a 6-digit TOTP or a recovery code). */
  login: async (username: string, password: string, totpCode?: string): Promise<void> => {
    const data = await requestJson<{ csrf_token?: string }>(
      "/login",
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, totp_code: totpCode }),
      },
    );
    if (typeof data.csrf_token === "string" && data.csrf_token.length > 0) {
      setDashboardCsrfToken(data.csrf_token);
    }
  },

  // ── Two-factor auth (TOTP) ─────────────────────────────────────────────────
  twofaStatus: (): Promise<{ enabled: boolean; pending: boolean }> => get("/2fa/status"),
  twofaSetup: (): Promise<{ secret: string; otpauth_uri: string }> =>
    postEmpty("/2fa/setup"),
  twofaEnable: (code: string): Promise<{ ok: boolean; recovery_codes: string[] }> =>
    postJsonRes("/2fa/enable", { code }),
  twofaDisable: (code: string): Promise<{ ok: boolean }> =>
    postJsonRes("/2fa/disable", { code }),

  /** Clear the current session cookie. */
  logout: async (): Promise<void> => {
    await requestJson("/logout", { method: "POST" }).catch(() => {
      /* ignore */
    });
    setDashboardCsrfToken(null);
  },

  me: (signal?: AbortSignal): Promise<DashboardSessionUser> => requestJson("/me", { method: "GET", signal }, { includePathInHttpError: true }),
};
