import { ContentLayout, Header, Table, SpaceBetween, Button, ButtonDropdown, Modal, FormField, Input, Select, Box, Alert, ColumnLayout, Container, ExpandableSection, Badge, Tabs } from "../components/ui/console";
import type { ButtonDropdownProps } from "../components/ui/console";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import {
  dashboardRoleLabel,
  type DashboardIdentity,
  type DashboardRole,
  type DashboardSessionUser,
  type DashboardUser,
} from "../lib/types";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { DashboardUserAvatar } from "../components/common/DashboardUserAvatar";
import {
  encodeUserLucideIcon,
  parseUserLucideIcon,
  resizeImageFileToJpegDataUrl,
} from "../lib/userAvatar";

const ROLE_OPTIONS: { label: string; value: DashboardRole; description: string }[] = [
  {
    label: "Viewer",
    value: "viewer",
    description: "Read agents, telemetry, activity, and audit log. Cannot use live screen, remote actions, or scripts.",
  },
  {
    label: "Operator",
    value: "operator",
    description:
      "Everything viewers can do, plus live screen, wake/clear history, software inventory refresh, agent icon, and remote scripts (when enabled on the server).",
  },
  {
    label: "Admin",
    value: "admin",
    description:
      "Full control: retention, auto-update policy, local UI passwords, users, agent groups, and alert rules.",
  },
];

/** Lucide React export names (PascalCase). Invalid names are skipped at render. */
const PROFILE_LUCIDE_NAMES = [
  "User",
  "UserCircle",
  "Shield",
  "Monitor",
  "Laptop",
  "Server",
  "HardDrive",
  "Briefcase",
  "Building2",
  "Wrench",
  "Rocket",
  "Star",
  "Globe",
  "Lock",
  "Key",
  "Eye",
  "Camera",
  "Cpu",
  "Wifi",
  "Terminal",
  "Code",
  "Database",
  "Fingerprint",
  "Bell",
  "Zap",
];

function UserAvatarFields({
  fullName,
  setFullName,
  username,
  setUsername,
  icon,
  setIcon,
  idLabel,
  isNarrow,
  onImportError,
}: {
  fullName: string;
  setFullName: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  icon: string;
  setIcon: (v: string) => void;
  idLabel: string;
  isNarrow: boolean;
  onImportError?: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const onPhotoChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f?.type.startsWith("image/")) return;
    setPhotoBusy(true);
    try {
      const dataUrl = await resizeImageFileToJpegDataUrl(f, 128, 0.82);
      setIcon(dataUrl);
    } catch (err: unknown) {
      onImportError?.(String((err as { message?: string })?.message || "Could not import photo"));
    } finally {
      setPhotoBusy(false);
    }
  };

  const grid = (
    <div className="vantyr-user-icon-grid">
      {PROFILE_LUCIDE_NAMES.map((name) => {
        const Cmp = (LucideIcons as unknown as Record<string, LucideIcon>)[name];
        if (!Cmp) return null;
        const encoded = encodeUserLucideIcon(name);
        const selected = icon === encoded || parseUserLucideIcon(icon) === name;
        return (
          <button
            key={name}
            type="button"
            className={`vantyr-user-lucide-pick${selected ? " vantyr-user-lucide-pick--selected" : ""}`}
            title={name}
            aria-label={`Use ${name} icon`}
            aria-pressed={selected}
            onClick={() => setIcon(encoded)}
          >
            <Cmp size={22} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );

  return (
    <SpaceBetween size="m">
      <ColumnLayout columns={isNarrow ? 1 : 2}>
        <FormField
          label="Full name"
          description="Shown in the top bar and user lists. Optional; sign-in still uses username below."
        >
          <Input
            value={fullName}
            onChange={({ detail }) => setFullName(detail.value)}
            placeholder="e.g. Jane Doe"
          />
        </FormField>
        <FormField label="Username" description={idLabel}>
          <Input value={username} onChange={({ detail }) => setUsername(detail.value)} />
        </FormField>
      </ColumnLayout>
      <FormField
        label="Avatar"
        description="Choose a Lucide icon or import a photo (JPEG/PNG/WebP/GIF). Cleared avatars use initials from your full name or username."
      >
        <SpaceBetween size="m">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(ev) => void onPhotoChange(ev)}
          />
          <SpaceBetween direction="horizontal" size="xs">
            <Button iconName="upload" onClick={() => fileRef.current?.click()} loading={photoBusy}>
              Import photo
            </Button>
            <Button variant="link" onClick={() => setIcon("")}>
              Clear avatar
            </Button>
          </SpaceBetween>
          <Box variant="awsui-key-label" margin={{ top: "xs" }}>
            Icon library
          </Box>
          {grid}
        </SpaceBetween>
      </FormField>
    </SpaceBetween>
  );
}

function roleBadge(role: DashboardRole) {
  const color = role === "admin" ? "red" : role === "operator" ? "blue" : "grey";
  return <Badge color={color}>{role}</Badge>;
}

export interface UsersPageProps {
  /** Refresh parent session user (e.g. App `checkAuth`) after profile/username updates. */
  onAccountUpdated?: () => void;
}

export function UsersPage({ onAccountUpdated }: UsersPageProps) {
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const [me, setMe] = useState<DashboardSessionUser | null>(null);
  const [users, setUsers] = useState<DashboardUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [create, setCreate] = useState<{
    display_name: string;
    username: string;
    password: string;
    role: DashboardRole;
  }>({
    display_name: "",
    username: "",
    password: "",
    role: "viewer",
  });

  const [pwModal, setPwModal] = useState<null | { id: string; username: string }>(null);
  const [pwValue, setPwValue] = useState("");

  const [idModal, setIdModal] = useState<null | { id: string; username: string }>(null);
  const [identities, setIdentities] = useState<DashboardIdentity[] | null>(null);
  const [identityLink, setIdentityLink] = useState({ issuer: "", subject: "" });

  const [selfDisplayName, setSelfDisplayName] = useState("");
  const [selfUsername, setSelfUsername] = useState("");
  const [selfIcon, setSelfIcon] = useState("");
  const [savingSelf, setSavingSelf] = useState(false);

  const [editOther, setEditOther] = useState<null | DashboardUser>(null);
  const [editOtherDisplayName, setEditOtherDisplayName] = useState("");
  const [editOtherUsername, setEditOtherUsername] = useState("");
  const [editOtherIcon, setEditOtherIcon] = useState("");
  const [savingOther, setSavingOther] = useState(false);

  const [accountTab, setAccountTab] = useState<"profile" | "admin">("profile");

  const canManage = me?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = await api.me();
      setMe(m);
      setSelfDisplayName(m.display_name?.trim() ?? "");
      setSelfUsername(m.username);
      setSelfIcon(m.display_icon?.trim() ?? "");

      if (m.role === "admin") {
        const u = await api.usersList();
        setUsers(u.users);
      } else {
        setUsers(null);
      }
    } catch (e: unknown) {
      setUsers(null);
      setError(String((e as { message?: string })?.message || "Failed to load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => users ?? [], [users]);

  const rowActions = (): ButtonDropdownProps.ItemOrGroup[] => [
    {
      id: "edit_profile",
      text: "Name, username & avatar",
    },
    {
      id: "set_role",
      text: "Set role",
      items: [
        { id: "role_viewer", text: "viewer" },
        { id: "role_operator", text: "operator" },
        { id: "role_admin", text: "admin" },
      ],
    },
    { id: "reset_password", text: "Reset password" },
    { id: "linked_oidc", text: "Linked OIDC identities" },
    { id: "delete", text: "Delete" },
  ];

  const runUserAction = async (u: DashboardUser, actionId: string) => {
    if (!canManage) return;
    const { id, username } = u;

    switch (actionId) {
      case "edit_profile": {
        setEditOther(u);
        setEditOtherDisplayName(u.display_name?.trim() ?? "");
        setEditOtherUsername(u.username);
        setEditOtherIcon(u.display_icon?.trim() ?? "");
        break;
      }
      case "role_viewer":
      case "role_operator":
      case "role_admin": {
        try {
          setActionError(null);
          const role = actionId.replace("role_", "") as DashboardRole;
          await api.userSetRole(id, role);
          await load();
        } catch (e: unknown) {
          setActionError(String((e as { message?: string })?.message || "Failed to update role"));
        }
        break;
      }
      case "reset_password": {
        setPwValue("");
        setPwModal({ id, username });
        break;
      }
      case "linked_oidc": {
        setIdentities(null);
        setIdentityLink({ issuer: "", subject: "" });
        setIdModal({ id, username });
        try {
          setActionError(null);
          const r = await api.userIdentities(id);
          setIdentities(r.identities);
        } catch (e: unknown) {
          setActionError(String((e as { message?: string })?.message || "Failed to load identities"));
        }
        break;
      }
      case "delete": {
        try {
          setActionError(null);
          await api.userDelete(id);
          await load();
        } catch (e: unknown) {
          setActionError(String((e as { message?: string })?.message || "Failed to delete user"));
        }
        break;
      }
    }
  };

  const saveSelfProfile = async () => {
    if (!me) return;
    const trimmedUser = selfUsername.trim();
    if (!trimmedUser) {
      setActionError("Username is required.");
      return;
    }
    setSavingSelf(true);
    setActionError(null);
    try {
      const body: { username?: string; display_name?: string; display_icon?: string | null } = {};
      const dnTrim = selfDisplayName.trim();
      const prevDn = me.display_name?.trim() ?? "";
      if (dnTrim !== prevDn) body.display_name = dnTrim;
      if (trimmedUser !== me.username) body.username = trimmedUser;
      const iconTrim = selfIcon.trim();
      const prev = me.display_icon?.trim() ?? "";
      if (iconTrim !== prev) {
        body.display_icon = iconTrim.length > 0 ? iconTrim : null;
      }
      if (Object.keys(body).length === 0) {
        setSavingSelf(false);
        return;
      }
      await api.userUpdateProfile(me.id, body);
      await load();
      onAccountUpdated?.();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to save profile"));
    } finally {
      setSavingSelf(false);
    }
  };

  const saveOtherProfile = async () => {
    if (!editOther) return;
    const trimmedUser = editOtherUsername.trim();
    if (!trimmedUser) {
      setActionError("Username is required.");
      return;
    }
    setSavingOther(true);
    setActionError(null);
    try {
      const body: { username?: string; display_name?: string; display_icon?: string | null } = {};
      const dnTrim = editOtherDisplayName.trim();
      const prevDn = editOther.display_name?.trim() ?? "";
      if (dnTrim !== prevDn) body.display_name = dnTrim;
      if (trimmedUser !== editOther.username) body.username = trimmedUser;
      const iconTrim = editOtherIcon.trim();
      const prev = editOther.display_icon?.trim() ?? "";
      if (iconTrim !== prev) {
        body.display_icon = iconTrim.length > 0 ? iconTrim : null;
      }
      if (Object.keys(body).length === 0) {
        setEditOther(null);
        setSavingOther(false);
        return;
      }
      await api.userUpdateProfile(editOther.id, body);
      setEditOther(null);
      await load();
      onAccountUpdated?.();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to save user"));
    } finally {
      setSavingOther(false);
    }
  };

  const headerActions = (
    <SpaceBetween direction="horizontal" size="xs">
      <Button iconName="refresh" onClick={() => void load()} loading={loading}>
        Refresh
      </Button>
      {canManage ? (
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          Create user
        </Button>
      ) : null}
    </SpaceBetween>
  );

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Profile is for everyone. Administration (roles, passwords, OIDC) is for admins only."
          actions={isNarrow ? undefined : headerActions}
        >
          Account
        </Header>
      }
    >
      <div className="vantyr-admin-page vantyr-users-page sx-console">
        <SpaceBetween size="l">
          {isNarrow ? <div className="vantyr-users-toolbar-mobile">{headerActions}</div> : null}

          {error ? <Box color="text-status-error">{error}</Box> : null}
          {actionError ? (
            <Alert type="error" dismissible onDismiss={() => setActionError(null)}>
              {actionError}
            </Alert>
          ) : null}

          {canManage ? (
            <Tabs
              activeTabId={accountTab}
              onChange={({ detail }) => setAccountTab(detail.activeTabId as "profile" | "admin")}
              tabs={[
                {
                  id: "profile",
                  label: "Profile",
                  content: me ? (
                    <Container
                      header={
                        <Header
                          variant="h2"
                          description="Your full name, sign-in username, and avatar. Changing username changes how you log in."
                        >
                          Your profile
                        </Header>
                      }
                    >
                      <SpaceBetween size="l">
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                          <DashboardUserAvatar
                            username={selfUsername || me.username}
                            displayName={selfDisplayName}
                            displayIcon={selfIcon || null}
                            size={56}
                          />
                          <Box color="text-body-secondary">
                            <Box variant="strong">{selfDisplayName.trim() || me.username}</Box>
                            <Box fontSize="body-s">
                              @{me.username} · {dashboardRoleLabel(me.role)}
                            </Box>
                          </Box>
                        </div>
                        <UserAvatarFields
                          fullName={selfDisplayName}
                          setFullName={setSelfDisplayName}
                          username={selfUsername}
                          setUsername={setSelfUsername}
                          icon={selfIcon}
                          setIcon={setSelfIcon}
                          idLabel="Must be unique. Use letters, numbers, or common punctuation."
                          isNarrow={isNarrow}
                          onImportError={(m) => setActionError(m)}
                        />
                        <Button variant="primary" onClick={() => void saveSelfProfile()} loading={savingSelf}>
                          Save profile
                        </Button>
                      </SpaceBetween>
                    </Container>
                  ) : null,
                },
                {
                  id: "admin",
                  label: "Administration",
                  content: (
                    <SpaceBetween size="l">
                      <ExpandableSection variant="container" headerText="What each role can do" defaultExpanded={false}>
                        <SpaceBetween size="s">
                          {ROLE_OPTIONS.map((r) => (
                            <Box key={r.value} padding="s">
                              <Box variant="strong">{r.label}</Box>
                              <Box color="text-body-secondary">{r.description}</Box>
                            </Box>
                          ))}
                        </SpaceBetween>
                      </ExpandableSection>
                      <Header variant="h2" description="Create users, assign roles, reset passwords, and manage OIDC links.">
                        All users
                      </Header>
                      {isNarrow ? (
                        loading && items.length === 0 ? (
                          <Box color="text-body-secondary">Loading users…</Box>
                        ) : items.length === 0 ? (
                          <Box color="text-body-secondary">No users.</Box>
                        ) : (
                          <SpaceBetween size="m">
                            {items.map((u) => (
                              <Box key={u.id} variant="div" className="vantyr-users-mobile-card">
                                <SpaceBetween size="s">
                                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                    <DashboardUserAvatar
                                      username={u.username}
                                      displayName={u.display_name}
                                      displayIcon={u.display_icon}
                                      size={40}
                                    />
                                    <div>
                                      <Box variant="h3" tagOverride="div" fontSize="heading-m">
                                        {u.display_name?.trim() || u.username}
                                      </Box>
                                      <Box fontSize="body-s" color="text-body-secondary">
                                        @{u.username}
                                      </Box>
                                      <Box>{roleBadge(u.role)}</Box>
                                    </div>
                                  </div>
                                  <Box color="text-body-secondary" fontSize="body-s">
                                    Created {new Date(u.created_at).toLocaleString()}
                                  </Box>
                                  <div className="vantyr-users-manage-slot">
                                    {canManage ? (
                                      <ButtonDropdown
                                        variant="primary"
                                        items={rowActions()}
                                        expandToViewport
                                        onItemClick={({ detail }) => {
                                          void runUserAction(u, detail.id);
                                        }}
                                      >
                                        Manage
                                      </ButtonDropdown>
                                    ) : (
                                      <Box color="text-body-secondary" fontSize="body-s">
                                        View only
                                      </Box>
                                    )}
                                  </div>
                                </SpaceBetween>
                              </Box>
                            ))}
                          </SpaceBetween>
                        )
                      ) : (
                        <Table
                          items={items}
                          loading={loading}
                          loadingText="Loading users"
                          columnDefinitions={[
                            {
                              id: "avatar",
                              header: "",
                              width: 52,
                              cell: (u) => (
                                <DashboardUserAvatar
                                  username={u.username}
                                  displayName={u.display_name}
                                  displayIcon={u.display_icon}
                                  size={32}
                                />
                              ),
                            },
                            {
                              id: "name",
                              header: "Name",
                              cell: (u) => u.display_name?.trim() || "—",
                            },
                            { id: "username", header: "Username", cell: (u) => u.username },
                            { id: "role", header: "Role", cell: (u) => roleBadge(u.role) },
                            {
                              id: "created",
                              header: "Created",
                              cell: (u) => new Date(u.created_at).toLocaleString(),
                            },
                            {
                              id: "actions",
                              header: "",
                              cell: (u) => (
                                canManage ? (
                                  <ButtonDropdown
                                    variant="normal"
                                    items={rowActions()}
                                    expandToViewport
                                    onItemClick={({ detail }) => {
                                      void runUserAction(u, detail.id);
                                    }}
                                  >
                                    Manage
                                  </ButtonDropdown>
                                ) : (
                                  <Box color="text-body-secondary" fontSize="body-s">
                                    —
                                  </Box>
                                )
                              ),
                            },
                          ]}
                          empty={<Box color="text-body-secondary">No users.</Box>}
                          variant="embedded"
                        />
                      )}
                    </SpaceBetween>
                  ),
                },
              ]}
            />
          ) : (
            <SpaceBetween size="l">
              {me ? (
                <Container
                  header={
                    <Header
                      variant="h2"
                      description="Your full name, sign-in username, and avatar. Changing username changes how you log in."
                    >
                      Your profile
                    </Header>
                  }
                >
                  <SpaceBetween size="l">
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <DashboardUserAvatar
                        username={selfUsername || me.username}
                        displayName={selfDisplayName}
                        displayIcon={selfIcon || null}
                        size={56}
                      />
                      <Box color="text-body-secondary">
                        <Box variant="strong">{selfDisplayName.trim() || me.username}</Box>
                        <Box fontSize="body-s">
                          @{me.username} · {dashboardRoleLabel(me.role)}
                        </Box>
                      </Box>
                    </div>
                    <UserAvatarFields
                      fullName={selfDisplayName}
                      setFullName={setSelfDisplayName}
                      username={selfUsername}
                      setUsername={setSelfUsername}
                      icon={selfIcon}
                      setIcon={setSelfIcon}
                      idLabel="Must be unique. Use letters, numbers, or common punctuation."
                      isNarrow={isNarrow}
                      onImportError={(m) => setActionError(m)}
                    />
                    <Button variant="primary" onClick={() => void saveSelfProfile()} loading={savingSelf}>
                      Save profile
                    </Button>
                  </SpaceBetween>
                </Container>
              ) : null}
              <Alert type="info" header="Administration">
                Only administrators can open the user directory, create accounts, or change roles. Ask an admin if you need a
                new account or role change.
              </Alert>
            </SpaceBetween>
          )}
        </SpaceBetween>

        <Modal
          visible={createOpen}
          onDismiss={() => setCreateOpen(false)}
          header="Create user"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!create.username.trim() || create.password.length < 6}
                  onClick={async () => {
                    try {
                      setActionError(null);
                      await api.userCreate({
                        username: create.username.trim(),
                        password: create.password,
                        role: create.role,
                        ...(create.display_name.trim() ? { display_name: create.display_name.trim() } : {}),
                      });
                      setCreate({ display_name: "", username: "", password: "", role: "viewer" });
                      setCreateOpen(false);
                      await load();
                    } catch (e: unknown) {
                      setActionError(String((e as { message?: string })?.message || "Failed to create user"));
                    }
                  }}
                >
                  Create
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <FormField label="Full name" description="Optional. Shown in the UI; sign-in still uses username.">
              <Input
                value={create.display_name}
                onChange={({ detail }) => setCreate((p) => ({ ...p, display_name: detail.value }))}
                placeholder="e.g. Jane Doe"
              />
            </FormField>
            <ColumnLayout columns={isNarrow ? 1 : 2}>
              <FormField label="Username">
                <Input
                  value={create.username}
                  onChange={({ detail }) => setCreate((p) => ({ ...p, username: detail.value }))}
                />
              </FormField>
              <FormField
                label="Role"
                description={ROLE_OPTIONS.find((o) => o.value === create.role)?.description ?? ""}
              >
                <Select
                  selectedOption={{
                    label: ROLE_OPTIONS.find((o) => o.value === create.role)?.label ?? create.role,
                    value: create.role,
                  }}
                  onChange={({ detail }) => {
                    const v = detail.selectedOption.value as DashboardRole | undefined;
                    if (v) setCreate((p) => ({ ...p, role: v }));
                  }}
                  options={ROLE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                />
              </FormField>
            </ColumnLayout>
            <FormField
              label="Temporary password"
              description="Min 6 characters. User can change later (reset again if needed)."
            >
              <Input
                type="password"
                value={create.password}
                onChange={({ detail }) => setCreate((p) => ({ ...p, password: detail.value }))}
              />
            </FormField>
          </SpaceBetween>
        </Modal>

        <Modal
          visible={Boolean(editOther)}
          onDismiss={() => setEditOther(null)}
          header={editOther ? `Profile: ${editOther.username}` : "Edit user"}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setEditOther(null)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void saveOtherProfile()} loading={savingOther}>
                  Save
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {editOther ? (
            <SpaceBetween size="l">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <DashboardUserAvatar
                  username={editOtherUsername || editOther.username}
                  displayName={editOtherDisplayName}
                  displayIcon={editOtherIcon || null}
                  size={48}
                />
                {roleBadge(editOther.role)}
              </div>
              <UserAvatarFields
                fullName={editOtherDisplayName}
                setFullName={setEditOtherDisplayName}
                username={editOtherUsername}
                setUsername={setEditOtherUsername}
                icon={editOtherIcon}
                setIcon={setEditOtherIcon}
                idLabel="Must be unique on this server."
                isNarrow={isNarrow}
                onImportError={(m) => setActionError(m)}
              />
            </SpaceBetween>
          ) : null}
        </Modal>

        <Modal
          visible={Boolean(pwModal)}
          onDismiss={() => setPwModal(null)}
          header={pwModal ? `Reset password: ${pwModal.username}` : "Reset password"}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setPwModal(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={pwValue.length < 6 || !pwModal}
                  onClick={async () => {
                    if (!pwModal) return;
                    try {
                      setActionError(null);
                      await api.userSetPassword(pwModal.id, pwValue);
                      setPwModal(null);
                      setPwValue("");
                    } catch (e: unknown) {
                      setActionError(String((e as { message?: string })?.message || "Failed to set password"));
                    }
                  }}
                >
                  Set password
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <FormField label="New password">
            <Input type="password" value={pwValue} onChange={({ detail }) => setPwValue(detail.value)} />
          </FormField>
        </Modal>

        <Modal
          visible={Boolean(idModal)}
          onDismiss={() => setIdModal(null)}
          header={idModal ? `Linked identities: ${idModal.username}` : "Linked identities"}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setIdModal(null)}>
                  Close
                </Button>
                <Button
                  variant="primary"
                  disabled={!identityLink.issuer.trim() || !identityLink.subject.trim() || !idModal}
                  onClick={async () => {
                    if (!idModal) return;
                    try {
                      setActionError(null);
                      await api.userIdentityLink(idModal.id, {
                        issuer: identityLink.issuer.trim(),
                        subject: identityLink.subject.trim(),
                      });
                      const r = await api.userIdentities(idModal.id);
                      setIdentities(r.identities);
                      setIdentityLink({ issuer: "", subject: "" });
                    } catch (e: unknown) {
                      setActionError(String((e as { message?: string })?.message || "Failed to link identity"));
                    }
                  }}
                >
                  Link identity
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <ColumnLayout columns={isNarrow ? 1 : 2}>
              <FormField label="Issuer">
                <Input
                  value={identityLink.issuer}
                  onChange={({ detail }) => setIdentityLink((p) => ({ ...p, issuer: detail.value }))}
                />
              </FormField>
              <FormField label="Subject (sub)">
                <Input
                  value={identityLink.subject}
                  onChange={({ detail }) => setIdentityLink((p) => ({ ...p, subject: detail.value }))}
                />
              </FormField>
            </ColumnLayout>
            {identities && identities.length > 0 ? (
              <Table
                items={identities}
                wrapLines
                columnDefinitions={[
                  {
                    id: "issuer",
                    header: "Issuer",
                    cell: (i: DashboardIdentity) => <Box className="vantyr-wrap-anywhere">{i.issuer}</Box>,
                  },
                  {
                    id: "subject",
                    header: "Subject",
                    cell: (i: DashboardIdentity) => <Box className="vantyr-wrap-anywhere">{i.subject}</Box>,
                  },
                  {
                    id: "unlink",
                    header: "",
                    cell: (i: DashboardIdentity) => (
                      <Button
                        variant="icon"
                        iconName="close"
                        ariaLabel="Unlink identity"
                        onClick={async () => {
                          try {
                            setActionError(null);
                            await api.identityUnlink(i.id);
                            if (idModal) {
                              const r = await api.userIdentities(idModal.id);
                              setIdentities(r.identities);
                            }
                          } catch (e: unknown) {
                            setActionError(String((e as { message?: string })?.message || "Failed to unlink identity"));
                          }
                        }}
                      />
                    ),
                  },
                ]}
                variant="embedded"
              />
            ) : (
              <Box color="text-body-secondary">No linked identities.</Box>
            )}
          </SpaceBetween>
        </Modal>
      </div>
    </ContentLayout>
  );
}
