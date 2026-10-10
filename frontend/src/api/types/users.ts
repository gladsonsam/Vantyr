// ── Dashboard users (admin) ───────────────────────────────────────────────────
// Generated from the server's user structs; see ./generated.

import type { DashboardUserRow } from "./generated/DashboardUserRow";
import type { SessionUser } from "./generated/SessionUser";

export type DashboardRole = SessionUser["role"];

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

/**
 * Session user from `GET /api/me` (includes CSRF for mutating API calls). `display_name` is the
 * full name shown in the UI (empty when unset); sign-in uses `username`. `display_icon` is a
 * Lucide key (`icon:lucide:Name`) or a small JPEG/PNG/WebP/GIF data URL.
 */
export type DashboardSessionUser = SessionUser;

/** Subset passed into the shell / top navigation. */
export type DashboardNavUser = Pick<DashboardSessionUser, "username" | "display_name" | "role" | "display_icon">;

/** A dashboard account as listed for admins; initials show when `display_icon` is unset. */
export type DashboardUser = DashboardUserRow;

export type { DashboardIdentityRow as DashboardIdentity } from "./generated/DashboardIdentityRow";
