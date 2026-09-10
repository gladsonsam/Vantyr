import type { DashboardRole } from "./types";

/**
 * Single source of truth for dashboard role gating.
 *
 * Backend model (`server/src/auth.rs`):
 * - `viewer`  = any authenticated user (read-only telemetry, no control)
 * - `operator` = viewer + live control (wake/clear, software refresh,
 *   scripts, icon, terminal, WS control) — `is_operator()` = operator OR admin
 * - `admin`   = operator + all config (retention, recall settings, enrollment,
 *   groups/rules, users, URL categorization writes, notifications, …)
 *
 * Keep this in sync with the backend table when endpoints change.
 */
export function isAdminRole(role: DashboardRole | null | undefined): boolean {
  return role === "admin";
}

export function isOperatorRole(role: DashboardRole | null | undefined): boolean {
  return role === "operator" || role === "admin";
}

export function canOperate(role: DashboardRole | null | undefined): boolean {
  return isOperatorRole(role);
}

export function canAdmin(role: DashboardRole | null | undefined): boolean {
  return isAdminRole(role);
}
