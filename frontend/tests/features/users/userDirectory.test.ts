import { describe, expect, it } from "bun:test";
import type { DashboardUser } from "@/api/types";
import {
  createdOn,
  deleteBlock,
  directorySummary,
  filterUsers,
  roleChangeBlock,
  roleChangeConsequence,
  userLabel,
} from "@/features/users/userDirectory";

const user = (
  id: string,
  username: string,
  role: DashboardUser["role"],
  display_name = "",
): DashboardUser => ({
  id,
  username,
  role,
  display_name,
  display_icon: null,
  created_at: "2026-01-01T00:00:00Z",
});
const admin = user("a", "root", "admin", "Root Admin");
const second = user("b", "second", "admin");
const op = user("o", "ops", "operator", "Ops User");
const viewer = user("v", "view", "viewer");

describe("userLabel", () => {
  it("prefers the trimmed full name over the username", () => {
    expect(userLabel(op)).toBe("Ops User");
    expect(userLabel({ username: "jane", display_name: "  " })).toBe("jane");
  });
});

describe("roleChangeBlock", () => {
  it("refuses to demote the only admin, and says so", () => {
    expect(roleChangeBlock(admin, "operator", [admin, op])).toContain("only admin");
  });
  it("allows demoting an admin when another admin remains", () => {
    expect(roleChangeBlock(admin, "viewer", [admin, second])).toBeNull();
  });
  it("allows promoting anyone, and skips a no-op change", () => {
    expect(roleChangeBlock(op, "admin", [admin, op])).toBeNull();
    expect(roleChangeBlock(op, "operator", [admin, op])).toBe("Already has this role.");
  });
});

describe("deleteBlock", () => {
  it("never offers deleting yourself", () => {
    expect(deleteBlock(admin, [admin, second], "a")).toContain("your own account");
  });
  it("never offers deleting the only admin", () => {
    expect(deleteBlock(admin, [admin, op], "o")).toContain("only admin");
  });
  it("allows deleting another user, or one of several admins", () => {
    expect(deleteBlock(op, [admin, op], "a")).toBeNull();
    expect(deleteBlock(second, [admin, second], "a")).toBeNull();
  });
});

describe("filterUsers", () => {
  const all = [admin, op, viewer];
  it("matches every word against name, username and role", () => {
    expect(filterUsers(all, "ops user")).toEqual([op]);
    expect(filterUsers(all, "VIEW")).toEqual([viewer]);
    expect(filterUsers(all, "admin")).toEqual([admin]);
    expect(filterUsers(all, "ops root")).toEqual([]);
  });
  it("returns everyone for a blank query", () => {
    expect(filterUsers(all, "  ")).toBe(all);
  });
});

describe("directorySummary", () => {
  it("counts users and lists only the roles somebody has", () => {
    expect(directorySummary([admin, second, op])).toBe("3 users · 2 admins · 1 operator");
    expect(directorySummary([viewer])).toBe("1 user · 1 viewer");
  });
});

describe("createdOn", () => {
  it("gives a short date and the full time, or null for an unreadable timestamp", () => {
    expect(createdOn("2026-01-01T00:00:00Z")?.short).toMatch(/2026|26/);
    expect(createdOn("nonsense")).toBeNull();
  });
});

describe("roleChangeConsequence", () => {
  it("says the person is signed out, and warns when you demote yourself", () => {
    expect(roleChangeConsequence(op, "admin", false).join(" ")).toContain(
      "Ops User will be signed out everywhere",
    );
    const self = roleChangeConsequence(admin, "viewer", true).join(" ");
    expect(self).toContain("You will be signed out");
    expect(self).toContain("no longer be able to manage users");
    expect(roleChangeConsequence(op, "admin", true).join(" ")).not.toContain("no longer");
  });
});
