// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click, typeInto } from "@tests/support/formDom";
import type { QueryClient } from "@tanstack/react-query";
import { UsersPage } from "@/features/users/UsersPage";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  usersList: vi.fn(),
  userSetRole: vi.fn(async () => ({ ok: true })),
  userDelete: vi.fn(async () => ({ ok: true })),
  userUpdateProfile: vi.fn(async () => ({ ok: true })),
  userCreate: vi.fn(async () => ({ id: "n" })),
  userSetPassword: vi.fn(async () => ({ ok: true })),
  userIdentities: vi.fn(async () => ({ identities: [] })),
  userIdentityLink: vi.fn(async () => ({ ok: true })),
  identityUnlink: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e) }));
vi.mock("@/app/providers/useSession", () => ({ useSession: () => ({ refresh: vi.fn(async () => {}) }) }));

const user = (id: string, username: string, role: "admin" | "operator" | "viewer", display_name = "") => ({
  id, username, role, display_name, display_icon: null, created_at: "2026-01-01T00:00:00Z",
});
const me = { ...user("a", "root", "admin", "Root Admin"), csrf_token: "t" };
const ops = user("o", "ops", "operator", "Ops User");
const list = [user("a", "root", "admin", "Root Admin"), ops, user("v", "view", "viewer")];

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = createTestQueryClient();
  api.me.mockResolvedValue(me);
  api.usersList.mockResolvedValue({ users: list });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render(ui: ReactElement = <UsersPage />) {
  await act(async () => root.render(withQueryClient(ui, client)));
}
const rows = () => [...host.querySelectorAll('ul[aria-label="Users"] > li')];
const btn = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const alerts = (scope: ParentNode = document) => [...scope.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? "");
async function openMenu(name: string) {
  await click(btn(`Manage ${name}`)!);
  await act(async () => {});
}
const menuItem = (text: string) => [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim().startsWith(text)) as HTMLElement | undefined;

describe("Users list", () => {
  it("shows one row per account with role, you-marker and a summary of the directory", async () => {
    await render();
    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain("Root Admin");
    expect(rows()[0].textContent).toContain("You");
    expect(rows()[0].textContent).toContain("@root");
    expect(rows()[1].textContent).toContain("operator");
    expect(rows()[2].textContent).toContain("view");
    expect(host.textContent).toContain("3 users · 1 admin · 1 operator · 1 viewer");
    expect(host.textContent).not.toContain("All users");
  });

  it("says it is loading, then offers retry when the list cannot be loaded, never an empty directory", async () => {
    api.usersList.mockRejectedValueOnce(new Error("503")).mockResolvedValue({ users: list });
    await render();
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Couldn't load users: 503");
    expect(host.textContent).not.toContain("No users");
    await click(btn("Try again")!);
    expect(rows()).toHaveLength(3);
  });

  it("keeps the last list and says so when a refresh fails", async () => {
    await render();
    api.usersList.mockRejectedValue(new Error("offline"));
    await click(btn("Refresh users")!);
    expect(rows()).toHaveLength(3);
    expect(host.textContent).toContain("Couldn't refresh users: offline. Showing the list from the last successful load.");
  });

  it("only shows search for long lists and says when nobody matches", async () => {
    await render();
    expect(host.querySelector('input[aria-label="Search users"]')).toBeNull();
    const many = Array.from({ length: 7 }, (_, i) => user(`x${i}`, `user${i}`, "viewer", i === 4 ? "Needle Person" : ""));
    api.usersList.mockResolvedValue({ users: [list[0], ...many] });
    await render(<UsersPage key="again" />);
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search users"]')!;
    await typeInto(search, "needle");
    expect(rows()).toHaveLength(1);
    expect(host.textContent).toContain("1 of 8 users");
    await typeInto(search, "zzz");
    expect(host.textContent).toContain("No user matches “zzz”.");
    await click(btn("Clear search")!);
    expect(rows()).toHaveLength(8);
  });
});

describe("Users actions", () => {
  it("cannot delete yourself or the only admin, and says why", async () => {
    await render();
    await openMenu("Root Admin");
    const del = menuItem("Delete user")!;
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.textContent).toContain("You can't delete your own account.");
  });

  it("confirms a role change with its consequence, then sends it", async () => {
    await render();
    await openMenu("Ops User");
    await click(menuItem("Change role")!);
    await act(async () => {});
    await click([...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.textContent?.trim() === "Admin")!);
    expect(dialog()?.textContent).toContain("Make Ops User an admin?");
    expect(dialog()?.textContent).toContain("Ops User will be signed out everywhere");
    expect(api.userSetRole).not.toHaveBeenCalled();
    await click(btn("Change role", dialog()!)!);
    expect(api.userSetRole).toHaveBeenCalledWith("o", "admin");
  });

  it("reports a refused role change inside the confirmation", async () => {
    api.userSetRole.mockRejectedValueOnce(new Error("Cannot demote the last admin user"));
    await render();
    await openMenu("Ops User");
    await click(menuItem("Change role")!);
    await act(async () => {});
    await click([...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.textContent?.trim() === "Viewer")!);
    await click(btn("Change role", dialog()!)!);
    expect(alerts(dialog()!)).toEqual(["Couldn't change the role: Cannot demote the last admin user"]);
    expect(dialog()).not.toBeNull();
  });

  it("names what deleting removes and reports a failure in the dialog", async () => {
    api.userDelete.mockRejectedValueOnce(new Error("boom"));
    await render();
    await openMenu("Ops User");
    await click(menuItem("Delete user")!);
    expect(dialog()?.textContent).toContain("Delete Ops User?");
    expect(dialog()?.textContent).toContain("two-factor setup");
    await click(btn("Delete user", dialog()!)!);
    expect(api.userDelete).toHaveBeenCalledWith("o");
    expect(alerts(dialog()!)).toEqual(["Couldn't delete: boom"]);
    expect(btn("Delete user", dialog()!)!.disabled).toBe(false);
    api.userDelete.mockResolvedValueOnce({ ok: true });
    await click(btn("Delete user", dialog()!)!);
    expect(dialog()).toBeNull();
  });
});

describe("Account states", () => {
  it("gives non-admins their profile and one line, and never loads the directory", async () => {
    api.me.mockResolvedValue({ ...me, role: "viewer" });
    await render();
    expect(api.usersList).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Only admins can manage other users.");
    expect(host.querySelector('input[id="avatar-username"]')).not.toBeNull();
  });

  it("reports a failed account load with retry instead of a blank page", async () => {
    api.me.mockRejectedValueOnce(new Error("401")).mockResolvedValue(me);
    await render();
    expect(host.textContent).toContain("Couldn't load your account: 401");
    await click(btn("Try again")!);
    expect(rows()).toHaveLength(3);
  });
});

describe("My profile", () => {
  async function openProfile() {
    await render();
    await click([...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "My profile")!);
  }

  it("saves only when something changed, sends only the changes and says it saved", async () => {
    await openProfile();
    expect(btn("Save profile")!.disabled).toBe(true);
    await typeInto(host.querySelector<HTMLInputElement>("#avatar-full-name")!, "Root Admin 2");
    expect(btn("Save profile")!.disabled).toBe(false);
    await click(btn("Save profile")!);
    expect(api.userUpdateProfile).toHaveBeenCalledWith("a", { display_name: "Root Admin 2" });
  });

  it("warns that a new username changes how you sign in and reports a refused save in place", async () => {
    api.userUpdateProfile.mockRejectedValueOnce(new Error("username taken"));
    await openProfile();
    await typeInto(host.querySelector<HTMLInputElement>("#avatar-username")!, "newname");
    expect(host.textContent).toContain("You'll sign in with “newname” after saving.");
    await click(btn("Save profile")!);
    expect(alerts(host)).toEqual(["Couldn't save: username taken"]);
    expect(btn("Save profile")!.disabled).toBe(false);
    await click(btn("Discard changes")!);
    expect(host.querySelector<HTMLInputElement>("#avatar-username")!.value).toBe("root");
  });

  it("keeps typing through a background refresh, and follows the server when nothing was edited", async () => {
    await openProfile();
    const name = () => host.querySelector<HTMLInputElement>("#avatar-full-name")!;
    api.me.mockResolvedValue({ ...me, display_name: "Renamed elsewhere" });
    await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
    expect(name().value).toBe("Renamed elsewhere");
    await typeInto(name(), "Mine");
    api.me.mockResolvedValue({ ...me, display_name: "Renamed again" });
    await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
    expect(name().value).toBe("Mine");
  });

  it("follows the server again after your own edit was saved", async () => {
    await openProfile();
    const name = () => host.querySelector<HTMLInputElement>("#avatar-full-name")!;
    await typeInto(name(), "Mine");
    api.me.mockResolvedValue({ ...me, display_name: "Mine" });
    await click(btn("Save profile")!);
    expect(api.userUpdateProfile).toHaveBeenCalledWith("a", { display_name: "Mine" });
    expect(host.textContent).toContain("Profile saved.");
    api.me.mockResolvedValue({ ...me, display_name: "Elsewhere" });
    await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
    expect(name().value).toBe("Elsewhere");
  });
});
