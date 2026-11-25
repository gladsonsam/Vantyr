import type { DashboardRole, DashboardUser } from "@/api/types";
import { ROLE_OPTIONS } from "./roles";

/** What a user is called in lists: the full name when there is one, else the username. */
export function userLabel(user: Pick<DashboardUser, "display_name" | "username">): string {
  return user.display_name?.trim() || user.username;
}

function adminCount(users: DashboardUser[]): number {
  return users.filter((u) => u.role === "admin").length;
}

/**
 * Why a role change can't be made, or null when it can. The server refuses to demote the last admin as
 * well; saying so here keeps the choice from being offered and then failing.
 */
export function roleChangeBlock(user: DashboardUser, role: DashboardRole, users: DashboardUser[]): string | null {
  if (user.role === role) return "Already has this role.";
  if (user.role === "admin" && adminCount(users) <= 1) return "The only admin. Make someone else an admin first.";
  return null;
}

/** Why a user can't be deleted, or null when they can (the server enforces both rules too). */
export function deleteBlock(user: DashboardUser, users: DashboardUser[], meId: string | null): string | null {
  if (user.id === meId) return "You can't delete your own account.";
  if (user.role === "admin" && adminCount(users) <= 1) return "The only admin. Make someone else an admin first.";
  return null;
}

/** Users whose name, username or role contains every word of the query. */
export function filterUsers(users: DashboardUser[], query: string): DashboardUser[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return users;
  return users.filter((u) => {
    const hay = `${u.display_name ?? ""} ${u.username} ${u.role}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/** "3 users · 1 admin · 1 operator · 1 viewer" — roles that nobody has are left out. */
export function directorySummary(users: DashboardUser[]): string {
  const parts = [`${users.length} ${users.length === 1 ? "user" : "users"}`];
  for (const { value } of [...ROLE_OPTIONS].reverse()) {
    const n = users.filter((u) => u.role === value).length;
    if (n > 0) parts.push(`${n} ${value}${n === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/** The date an account was created, or null when the server's timestamp can't be read. */
export function createdOn(createdAt: string): { short: string; full: string } | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return { short: date.toLocaleDateString(undefined, { dateStyle: "medium" }), full: date.toLocaleString() };
}

/** What a role change does, for the confirmation: the new access and that the person is signed out. */
export function roleChangeConsequence(user: DashboardUser, role: DashboardRole, isSelf: boolean): string[] {
  const description = ROLE_OPTIONS.find((o) => o.value === role)?.description ?? "";
  const lines = [description];
  lines.push(
    isSelf
      ? "You will be signed out right away and sign back in with the new role."
      : `${userLabel(user)} will be signed out everywhere and sign back in with the new role.`,
  );
  if (isSelf && role !== "admin") lines.push("You will no longer be able to manage users.");
  return lines;
}
