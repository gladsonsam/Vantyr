import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import {
  buttonByText,
  byLabel,
  click,
  fieldErrors,
  mountForm,
  typeInto,
  unmountForms,
} from "@tests/support/formDom";
import type { DashboardUser } from "@/api/types";
import { CreateUserModal } from "@/features/users/CreateUserModal";
import { EditUserModal } from "@/features/users/EditUserModal";
import { OidcIdentitiesModal } from "@/features/users/OidcIdentitiesModal";
import { ResetPasswordModal } from "@/features/users/ResetPasswordModal";

afterEach(unmountForms);

const alerts = () =>
  Array.from(document.querySelectorAll('[role="alert"]')).map((e) => e.textContent ?? "");

describe("CreateUserModal", () => {
  async function open() {
    const onCreate = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<CreateUserModal visible onDismiss={onDismiss} onCreate={onCreate} />);
    return { onCreate, onDismiss };
  }

  it("keeps Create disabled until there is a username and a password of 6+ characters, without showing errors", async () => {
    await open();
    expect(buttonByText("Create user").disabled).toBe(true);
    await typeInto(byLabel("Username"), "jane");
    await typeInto(byLabel("Temporary password"), "12345");
    expect(buttonByText("Create user").disabled).toBe(true);
    expect(fieldErrors()).toEqual([]);
    await typeInto(byLabel("Temporary password"), "123456");
    expect(buttonByText("Create user").disabled).toBe(false);
  });

  it("creates the user with a trimmed username and dismisses on success", async () => {
    const { onCreate, onDismiss } = await open();
    await typeInto(byLabel("Username"), " jane ");
    await typeInto(byLabel("Temporary password"), "secret1");
    await click(buttonByText("Create user"));
    expect(onCreate).toHaveBeenCalledWith({
      display_name: "",
      username: "jane",
      password: "secret1",
      role: "viewer",
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays open when the parent rejects", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("nope");
    });
    const onDismiss = vi.fn();
    await mountForm(<CreateUserModal visible onDismiss={onDismiss} onCreate={onCreate} />);
    await typeInto(byLabel("Username"), "jane");
    await typeInto(byLabel("Temporary password"), "secret1");
    await click(buttonByText("Create user"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    // The reason is shown in the dialog, where the person who pressed Create is looking.
    expect(alerts()).toEqual(["Couldn't create the user: nope"]);
    expect(buttonByText("Create user").disabled).toBe(false);
  });

  it("describes the role it starts with", async () => {
    await open();
    expect(document.body.textContent).toContain("Read agents, telemetry, activity, and audit log");
  });
});

describe("ResetPasswordModal", () => {
  it("enables Set password at 6 characters and confirms with the typed password", async () => {
    const onConfirm = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(
      <ResetPasswordModal
        visible
        onDismiss={onDismiss}
        name="Jane"
        isSelf={false}
        onConfirm={onConfirm}
      />,
    );
    expect(buttonByText("Set password").disabled).toBe(true);
    await typeInto(byLabel("New password"), "abcde");
    expect(buttonByText("Set password").disabled).toBe(true);
    await typeInto(byLabel("New password"), "abcdef");
    await click(buttonByText("Set password"));
    expect(onConfirm).toHaveBeenCalledWith("abcdef");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ResetPasswordModal consequences and failure", () => {
  it("says the account is signed out everywhere, or that you are, for your own", async () => {
    await mountForm(
      <ResetPasswordModal
        visible
        onDismiss={vi.fn()}
        name="Jane"
        isSelf={false}
        onConfirm={vi.fn(async () => {})}
      />,
    );
    expect(document.body.textContent).toContain("Jane will be signed out everywhere");
    unmountForms();
    await mountForm(
      <ResetPasswordModal
        visible
        onDismiss={vi.fn()}
        name="Jane"
        isSelf
        onConfirm={vi.fn(async () => {})}
      />,
    );
    expect(document.body.textContent).toContain("You will be signed out right away");
  });

  it("keeps the dialog open and reports why when the password is refused", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("too weak");
    });
    const onDismiss = vi.fn();
    await mountForm(
      <ResetPasswordModal
        visible
        onDismiss={onDismiss}
        name="Jane"
        isSelf={false}
        onConfirm={onConfirm}
      />,
    );
    await typeInto(byLabel("New password"), "abcdef");
    await click(buttonByText("Set password"));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["Couldn't set the password: too weak"]);
  });
});

describe("OidcIdentitiesModal", () => {
  it("links a trimmed issuer and subject and clears the fields", async () => {
    const onLink = vi.fn(async () => {});
    await mountForm(
      <OidcIdentitiesModal
        visible
        onDismiss={vi.fn()}
        name="Jane"
        identities={[]}
        loadError={null}
        loading={false}
        onReload={vi.fn()}
        onLink={onLink}
        onUnlink={vi.fn()}
      />,
    );
    expect(buttonByText("Link identity").disabled).toBe(true);
    await typeInto(byLabel("Issuer"), " https://idp ");
    await typeInto(byLabel("Subject (sub)"), " abc ");
    await click(buttonByText("Link identity"));
    expect(onLink).toHaveBeenCalledWith({ issuer: "https://idp", subject: "abc" });
    expect(byLabel("Issuer").value).toBe("");
  });
});

describe("OidcIdentitiesModal states", () => {
  const identity = {
    id: 7,
    issuer: "https://idp",
    subject: "abc-123",
    user_id: "u1",
    preferred_username: null,
    email: null,
    name: null,
    last_login_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
  const base = {
    visible: true,
    onDismiss: vi.fn(),
    name: "Jane",
    loadError: null,
    loading: false,
    onReload: vi.fn(),
    onLink: vi.fn(async () => {}),
    onUnlink: vi.fn(async () => {}),
  };

  it("says it is loading instead of claiming there are no identities", async () => {
    await mountForm(<OidcIdentitiesModal {...base} identities={null} loading />);
    expect(document.body.textContent).toContain("Loading linked identities…");
    expect(document.body.textContent).not.toContain("No linked identities.");
  });

  it("reports a failed load with a retry, never as an empty list", async () => {
    const onReload = vi.fn();
    await mountForm(
      <OidcIdentitiesModal {...base} identities={null} loadError="503" onReload={onReload} />,
    );
    expect(alerts()).toEqual(["Couldn't load linked identities: 503 Try again"]);
    expect(document.body.textContent).not.toContain("No linked identities.");
    await click(buttonByText("Try again"));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("keeps the old list and says so when a refresh fails", async () => {
    await mountForm(<OidcIdentitiesModal {...base} identities={[identity]} loadError="503" />);
    expect(document.body.textContent).toContain("Showing the list from the last successful load");
    expect(document.body.textContent).toContain("abc-123");
  });

  it("asks before unlinking and names the consequence", async () => {
    const onUnlink = vi.fn(async () => {});
    await mountForm(<OidcIdentitiesModal {...base} identities={[identity]} onUnlink={onUnlink} />);
    await click(document.querySelector('button[aria-label="Unlink identity abc-123"]')!);
    expect(onUnlink).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Jane will no longer be able to sign in with this identity.",
    );
    await click(buttonByText("Unlink"));
    expect(onUnlink).toHaveBeenCalledWith(7);
  });

  it("keeps the unlink question open and reports a refusal in the row", async () => {
    const onUnlink = vi.fn(async () => {
      throw new Error("gone");
    });
    await mountForm(<OidcIdentitiesModal {...base} identities={[identity]} onUnlink={onUnlink} />);
    await click(document.querySelector('button[aria-label="Unlink identity abc-123"]')!);
    await click(buttonByText("Unlink"));
    expect(alerts()).toEqual(["Couldn't unlink: gone"]);
    await click(buttonByText("Keep linked"));
    expect(alerts()).toEqual([]);
  });

  it("reports a refused link in the dialog and keeps what was typed", async () => {
    const onLink = vi.fn(async () => {
      throw new Error("already linked");
    });
    await mountForm(<OidcIdentitiesModal {...base} identities={[]} onLink={onLink} />);
    await typeInto(byLabel("Issuer"), "https://idp");
    await typeInto(byLabel("Subject (sub)"), "abc");
    await click(buttonByText("Link identity"));
    expect(alerts()).toEqual(["Couldn't link: already linked"]);
    expect(byLabel("Issuer").value).toBe("https://idp");
  });
});

describe("EditUserModal", () => {
  const user: DashboardUser = {
    id: "u1",
    username: "jane",
    display_name: "Jane",
    role: "operator",
    display_icon: null,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("starts from the user's profile and blocks save when the username is cleared", async () => {
    const onSave = vi.fn(async () => {});
    await mountForm(
      <EditUserModal user={user} isSelf={false} onDismiss={vi.fn()} onSave={onSave} />,
    );
    expect(byLabel("Username").value).toBe("jane");
    expect(byLabel("Full name").value).toBe("Jane");
    expect(buttonByText("Save").disabled).toBe(false);
    await typeInto(byLabel("Username"), "  ");
    expect(buttonByText("Save").disabled).toBe(true);
    expect(fieldErrors()).toEqual(["Username is required."]);
  });

  it("keeps the dialog open and reports why the save failed", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("username taken");
    });
    const onDismiss = vi.fn();
    await mountForm(
      <EditUserModal user={user} isSelf={false} onDismiss={onDismiss} onSave={onSave} />,
    );
    await typeInto(byLabel("Username"), "taken");
    await click(buttonByText("Save"));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["Couldn't save: username taken"]);
  });

  it("saves the edited profile and dismisses", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(
      <EditUserModal user={user} isSelf={false} onDismiss={onDismiss} onSave={onSave} />,
    );
    await typeInto(byLabel("Full name"), "Jane Doe");
    await click(buttonByText("Save"));
    expect(onSave).toHaveBeenCalledWith({
      display_name: "Jane Doe",
      username: "jane",
      display_icon: "",
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
