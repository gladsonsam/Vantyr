// ── Dashboard users (admin) ───────────────────────────────────────────────────

export type DashboardRole = "admin" | "operator" | "viewer";

/** Human-readable role for UI (nav, labels). */
export function dashboardRoleLabel(role: DashboardRole): string {
  switch (role) {
    case "admin":
      return "Administrator";
    case "operator":
      return "Operator";
    case "viewer":
      return "Viewer";
  }
}

/** Session user from `GET /api/me` (includes CSRF for mutating API calls). */
export interface DashboardSessionUser {
  id: string;
  username: string;
  /** Optional full name shown in the UI; sign-in uses `username`. */
  display_name?: string;
  role: DashboardRole;
  /** Lucide key (`icon:lucide:Name`) or small JPEG/PNG/WebP/GIF data URL. */
  display_icon?: string | null;
  csrf_token?: string;
}

/** Subset passed into the shell / top navigation. */
export type DashboardNavUser = Pick<DashboardSessionUser, "username" | "display_name" | "role" | "display_icon">;

export interface DashboardUser {
  id: string;
  username: string;
  display_name?: string;
  role: DashboardRole;
  /** Lucide icon key or photo data URL; initials when unset. */
  display_icon?: string | null;
  created_at: string;
}

export interface DashboardIdentity {
  id: number;
  issuer: string;
  subject: string;
  preferred_username?: string | null;
  email?: string | null;
  name?: string | null;
  last_login_at: string;
  created_at: string;
}
