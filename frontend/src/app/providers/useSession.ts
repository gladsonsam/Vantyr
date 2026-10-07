import { createContext, useContext } from "react";
import type { DashboardNavUser, DashboardSessionUser } from "@/lib/types";

export interface SessionContextValue {
  /** `null` until the first auth check settles. */
  authenticated: boolean | null;
  user: DashboardSessionUser | null;
  /** Subset of `user` shown in the shell. */
  navUser: DashboardNavUser | null;
  /** Re-check the session and refresh the user and CSRF token. */
  refresh: () => Promise<void>;
  /** Mark the session signed in after the login page succeeds. */
  completeLogin: () => void;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
