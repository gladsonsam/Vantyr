import type { ApiClient } from "@/api";
import { demoUser } from "@/demo/data";

/** Fake sign-in, session and two-factor endpoints. */
export function demoAuthApi(): Partial<ApiClient> {
  return {
    authStatus: async () => ({ authenticated: true, password_required: false }),
    authConfig: async () => ({ oidc_enabled: false, oidc_auto_login: false }),
    login: async () => undefined,
    logout: async () => undefined,
    me: async () => demoUser,
    twofaStatus: async () => ({ enabled: false, pending: false }),
    twofaSetup: async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/Vantyr:demo?secret=JBSWY3DPEHPK3PXP&issuer=Vantyr" }),
    twofaEnable: async () => ({ ok: true, recovery_codes: ["abcd-efgh", "jkmn-pqrs", "tuvw-xy23", "4567-89ab", "cdef-ghjk"] }),
    twofaDisable: async () => ({ ok: true }),
  };
}
