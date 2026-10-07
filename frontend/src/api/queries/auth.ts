import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

/**
 * Sign-in related server state read by screens. The session bootstrap (auth status, CSRF token,
 * nav user) stays in SessionProvider.
 */
export const authKeys = {
  all: ["auth"] as const,
  /** The signed-in user (`/me`). */
  me: () => [...authKeys.all, "me"] as const,
  /** Login-screen config (OIDC enabled / auto-login). */
  config: () => [...authKeys.all, "config"] as const,
  /** The signed-in user's two-factor status. */
  twofaStatus: () => [...authKeys.all, "2fa-status"] as const,
};

export const authQueries = {
  me: () =>
    queryOptions({
      queryKey: authKeys.me(),
      queryFn: () => api.me(),
    }),
  config: () =>
    queryOptions({
      queryKey: authKeys.config(),
      queryFn: () => api.authConfig(),
    }),
  twofaStatus: () =>
    queryOptions({
      queryKey: authKeys.twofaStatus(),
      queryFn: () => api.twofaStatus(),
    }),
};
