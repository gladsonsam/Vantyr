// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@/test/formDom";
import type { DashboardUser } from "@/api/types";
import { CreateUserModal } from "./CreateUserModal";
import { EditUserModal } from "./EditUserModal";
import { OidcIdentitiesModal } from "./OidcIdentitiesModal";
import { ResetPasswordModal } from "./ResetPasswordModal";

afterEach(unmountForms);

describe("CreateUserModal", () => {
  async function open() {
    const onCreate = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<CreateUserModal visible onDismiss={onDismiss} isNarrow={false} onCreate={onCreate} />);
    return { onCreate, onDismiss };
  }

  it("keeps Create disabled until there is a username and a password of 6+ characters, without showing errors", async () => {
    await open();
    expect(buttonByText("Create").disabled).toBe(true);
    await typeInto(byLabel("Username"), "jane");
    await typeInto(byLabel("Temporary password"), "12345");
    expect(buttonByText("Create").disabled).toBe(true);
    expect(fieldErrors()).toEqual([]);
    await typeInto(byLabel("Temporary password"), "123456");
    expect(buttonByText("Create").disabled).toBe(false);
  });

  it("creates the user with a trimmed username and dismisses on success", async () => {
    const { onCreate, onDismiss } = await open();
    await typeInto(byLabel("Username"), " jane ");
    await typeInto(byLabel("Temporary password"), "secret1");
    await click(buttonByText("Create"));
    expect(onCreate).toHaveBeenCalledWith({ display_name: "", username: "jane", password: "secret1", role: "viewer" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays open when the parent rejects", async () => {
    const onCreate = vi.fn(async () => { throw new Error("nope"); });
    const onDismiss = vi.fn();
    await mountForm(<CreateUserModal visible onDismiss={onDismiss} isNarrow={false} onCreate={onCreate} />);
    await typeInto(byLabel("Username"), "jane");
    await typeInto(byLabel("Temporary password"), "secret1");
    await click(buttonByText("Create"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("ResetPasswordModal", () => {
  it("enables Set password at 6 characters and confirms with the typed password", async () => {
    const onConfirm = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<ResetPasswordModal visible onDismiss={onDismiss} username="jane" onConfirm={onConfirm} />);
    expect(buttonByText("Set password").disabled).toBe(true);
    await typeInto(byLabel("New password"), "abcde");
    expect(buttonByText("Set password").disabled).toBe(true);
    await typeInto(byLabel("New password"), "abcdef");
    await click(buttonByText("Set password"));
    expect(onConfirm).toHaveBeenCalledWith("abcdef");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("OidcIdentitiesModal", () => {
  it("links a trimmed issuer and subject and clears the fields", async () => {
    const onLink = vi.fn(async () => {});
    await mountForm(<OidcIdentitiesModal visible onDismiss={vi.fn()} username="jane" isNarrow={false} identities={[]} onLink={onLink} onUnlink={vi.fn()} />);
    expect(buttonByText("Link identity").disabled).toBe(true);
    await typeInto(byLabel("Issuer"), " https://idp ");
    await typeInto(byLabel("Subject (sub)"), " abc ");
    await click(buttonByText("Link identity"));
    expect(onLink).toHaveBeenCalledWith({ issuer: "https://idp", subject: "abc" });
    expect(byLabel("Issuer").value).toBe("");
  });
});

describe("EditUserModal", () => {
  const user: DashboardUser = { id: "u1", username: "jane", display_name: "Jane", role: "operator", display_icon: null, created_at: "2026-01-01T00:00:00Z" };

  it("starts from the user's profile and blocks save when the username is cleared", async () => {
    const onSave = vi.fn(async () => {});
    await mountForm(<EditUserModal user={user} onDismiss={vi.fn()} isNarrow={false} onSave={onSave} />);
    expect(byLabel("Username").value).toBe("jane");
    expect(byLabel("Full name").value).toBe("Jane");
    expect(buttonByText("Save").disabled).toBe(false);
    await typeInto(byLabel("Username"), "  ");
    expect(buttonByText("Save").disabled).toBe(true);
    expect(fieldErrors()).toEqual([]);
  });

  it("saves the edited profile and dismisses", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<EditUserModal user={user} onDismiss={onDismiss} isNarrow={false} onSave={onSave} />);
    await typeInto(byLabel("Full name"), "Jane Doe");
    await click(buttonByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ display_name: "Jane Doe", username: "jane", display_icon: "" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
