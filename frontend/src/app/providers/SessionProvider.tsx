import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setDashboardCsrfToken } from "@/api";
import { clearSsoGuards, markSsoManual } from "@/features/auth/sso";
import type { DashboardNavUser, DashboardSessionUser } from "@/api/types";
import { SessionContext, type SessionContextValue } from "./useSession";
import { onSessionExpired } from "@/api/sessionExpiry";

function toNavUser(user: DashboardSessionUser | null): DashboardNavUser | null {
  if (!user) return null;
  return {
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    display_icon: user.display_icon,
  };
}

interface SessionState {
  authenticated: boolean;
  user: DashboardSessionUser | null;
  csrfToken: string | null;
}

const SIGNED_OUT: SessionState = { authenticated: false, user: null, csrfToken: null };

async function fetchSessionState(): Promise<SessionState> {
  try {
    // Sequential on purpose: me() is only meaningful when authenticated, and an
    // unauthenticated me() call would fire a pointless 401 into the expiry handler.
    const st = await api.authStatus();
    if (!st?.authenticated) return { authenticated: false, user: null, csrfToken: null };
    const data = await api.me().catch(() => null);
    const csrfToken =
      data && typeof data.csrf_token === "string" && data.csrf_token.length > 0
        ? data.csrf_token
        : null;
    return { authenticated: true, user: data, csrfToken };
  } catch {
    return { authenticated: false, user: null, csrfToken: null };
  }
}

/** Owns the dashboard sign-in state: auth check, current user, CSRF token and logout. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<DashboardSessionUser | null>(null);
  const queryClient = useQueryClient();

  // The one place server state is dropped: whenever the signed-in account ends or changes, the
  // TanStack cache is cleared so no account ever sees another account's data.
  const accountIdRef = useRef<string | null>(null);
  const applySessionState = useCallback(
    (state: SessionState) => {
      const accountId = state.authenticated ? (state.user?.id ?? null) : null;
      // Signing in from signed-out needs no clear: the cache was emptied when that session ended.
      if (accountIdRef.current !== null && accountIdRef.current !== accountId) queryClient.clear();
      accountIdRef.current = accountId;
      setUser(state.user);
      setDashboardCsrfToken(state.csrfToken);
      setAuthenticated(state.authenticated);
    },
    [queryClient],
  );

  const refresh = useCallback(async () => {
    applySessionState(await fetchSessionState());
  }, [applySessionState]);

  // Initial load subscribes to the one-shot fetch so a superseding unmount
  // drops the late result instead of publishing it.
  useEffect(() => {
    let cancelled = false;
    void fetchSessionState().then((state) => {
      if (!cancelled) applySessionState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [applySessionState]);

  // A successful sign-in (local or SSO round-trip) resets the SSO guards so the
  // *next* session expiry is allowed one automatic hop again.
  useEffect(() => {
    if (authenticated === true) clearSsoGuards();
  }, [authenticated]);

  // Recover gracefully when the server reports the session has expired (any 401
  // from the fetch layer reports it) — demote to signed-out so the login
  // screen shows and the WebSocket reconnect loop stops.
  useEffect(() => onSessionExpired(() => applySessionState(SIGNED_OUT)), [applySessionState]);

  const completeLogin = useCallback(() => {
    clearSsoGuards();
    setAuthenticated(true);
    // The login response carries no user (and not always a CSRF token); load the
    // session now rather than leaving the shell without them until a reload.
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      console.error("Logout error:", err);
    }
    // Explicit sign-out must land on the login screen — suppress the SSO
    // auto-hop for this tab until the next successful sign-in.
    markSsoManual();
    applySessionState(SIGNED_OUT);
  }, [applySessionState]);

  const value = useMemo<SessionContextValue>(
    () => ({ authenticated, user, navUser: toNavUser(user), refresh, completeLogin, logout }),
    [authenticated, user, refresh, completeLogin, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
