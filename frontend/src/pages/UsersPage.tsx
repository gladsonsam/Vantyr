import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Settings2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../lib/api";
import {
  dashboardRoleLabel,
  type DashboardIdentity,
  type DashboardRole,
  type DashboardSessionUser,
  type DashboardUser,
} from "../lib/types";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSession } from "@/app/providers/useSession";
import { DashboardUserAvatar } from "../components/common/DashboardUserAvatar";
import { UserAvatarFields } from "../components/users/UserAvatarFields";
import { CreateUserModal } from "../components/users/CreateUserModal";
import { EditUserModal } from "../components/users/EditUserModal";
import { ResetPasswordModal } from "../components/users/ResetPasswordModal";
import { OidcIdentitiesModal } from "../components/users/OidcIdentitiesModal";

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

const ROLE_TEXT: Record<DashboardRole, string> = {
  admin: "text-warning",
  operator: "text-info",
  viewer: "text-muted-foreground",
};

function RoleText({ role }: { role: DashboardRole }) {
  return <span className={`text-sm font-medium ${ROLE_TEXT[role]}`}>{role}</span>;
}

export function UsersPage() {
  // Refresh the session user after profile/username updates.
  const { refresh: refreshSession } = useSession();
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const [me, setMe] = useState<DashboardSessionUser | null>(null);
  const [users, setUsers] = useState<DashboardUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);

  const [pwModal, setPwModal] = useState<null | { id: string; username: string }>(null);

  const [idModal, setIdModal] = useState<null | { id: string; username: string }>(null);
  const [identities, setIdentities] = useState<DashboardIdentity[] | null>(null);

  const [selfDisplayName, setSelfDisplayName] = useState("");
  const [selfUsername, setSelfUsername] = useState("");
  const [selfIcon, setSelfIcon] = useState("");
  const [savingSelf, setSavingSelf] = useState(false);

  const [editOther, setEditOther] = useState<null | DashboardUser>(null);
  const [deleteUser, setDeleteUser] = useState<null | DashboardUser>(null);
  const [deleting, setDeleting] = useState(false);

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

  const setRole = async (u: DashboardUser, role: DashboardRole) => {
    try {
      setActionError(null);
      await api.userSetRole(u.id, role);
      await load();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to update role"));
    }
  };

  const openIdentities = async (u: DashboardUser) => {
    setIdentities(null);
    setIdModal({ id: u.id, username: u.username });
    try {
      setActionError(null);
      const r = await api.userIdentities(u.id);
      setIdentities(r.identities);
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to load identities"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteUser || !canManage) return;
    setDeleting(true);
    try {
      setActionError(null);
      await api.userDelete(deleteUser.id);
      setDeleteUser(null);
      await load();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to delete user"));
    } finally {
      setDeleting(false);
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
      void refreshSession();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to save profile"));
    } finally {
      setSavingSelf(false);
    }
  };

  const saveOtherProfile = async (data: { display_name: string; username: string; display_icon: string }) => {
    if (!editOther) return;
    const trimmedUser = data.username.trim();
    if (!trimmedUser) {
      setActionError("Username is required.");
      return;
    }
    setActionError(null);
    try {
      const body: { username?: string; display_name?: string; display_icon?: string | null } = {};
      const dnTrim = data.display_name.trim();
      const prevDn = editOther.display_name?.trim() ?? "";
      if (dnTrim !== prevDn) body.display_name = dnTrim;
      if (trimmedUser !== editOther.username) body.username = trimmedUser;
      const iconTrim = data.display_icon.trim();
      const prev = editOther.display_icon?.trim() ?? "";
      if (iconTrim !== prev) {
        body.display_icon = iconTrim.length > 0 ? iconTrim : null;
      }
      if (Object.keys(body).length === 0) {
        setEditOther(null);
        return;
      }
      await api.userUpdateProfile(editOther.id, body);
      setEditOther(null);
      await load();
      void refreshSession();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to save user"));
      throw e;
    }
  };

  const handleCreateUser = async (data: {
    display_name: string;
    username: string;
    password: string;
    role: DashboardRole;
  }) => {
    try {
      setActionError(null);
      await api.userCreate({
        username: data.username.trim(),
        password: data.password,
        role: data.role,
        ...(data.display_name.trim() ? { display_name: data.display_name.trim() } : {}),
      });
      await load();
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to create user"));
      throw e;
    }
  };

  const handleResetPassword = async (password: string) => {
    if (!pwModal) return;
    try {
      setActionError(null);
      await api.userSetPassword(pwModal.id, password);
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to set password"));
      throw e;
    }
  };

  const handleLinkIdentity = async (identity: { issuer: string; subject: string }) => {
    if (!idModal) return;
    try {
      setActionError(null);
      await api.userIdentityLink(idModal.id, {
        issuer: identity.issuer.trim(),
        subject: identity.subject.trim(),
      });
      const r = await api.userIdentities(idModal.id);
      setIdentities(r.identities);
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to link identity"));
      throw e;
    }
  };

  const handleUnlinkIdentity = async (identityId: number) => {
    try {
      setActionError(null);
      await api.identityUnlink(identityId);
      if (idModal) {
        const r = await api.userIdentities(idModal.id);
        setIdentities(r.identities);
      }
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message || "Failed to unlink identity"));
      throw e;
    }
  };

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
        {loading ? <Spinner /> : <RefreshCw />} Refresh
      </Button>
      {canManage ? (
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus /> Create user
        </Button>
      ) : null}
    </div>
  );

  const profileCard = me ? (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Your profile</CardTitle>
        <CardDescription>
          Your full name, sign-in username, and avatar. Changing username changes how you log in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        <div className="flex items-center gap-4 pt-1">
          <DashboardUserAvatar
            username={selfUsername || me.username}
            displayName={selfDisplayName}
            displayIcon={selfIcon || null}
            size={56}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold">{selfDisplayName.trim() || me.username}</div>
            <div className="text-sm text-muted-foreground">
              @{me.username} · {dashboardRoleLabel(me.role)}
            </div>
          </div>
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
        <div>
          <Button disabled={savingSelf} onClick={() => void saveSelfProfile()}>
            {savingSelf && <Spinner />} Save profile
          </Button>
        </div>
      </CardContent>
    </Card>
  ) : null;

  const manageMenu = (u: DashboardUser) =>
    canManage ? (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <Settings2 /> Manage
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => setEditOther(u)}>
            Name, username &amp; avatar
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Set role</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(["viewer", "operator", "admin"] as const).map((role) => (
                <DropdownMenuItem key={role} onClick={() => void setRole(u, role)}>
                  {role}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => setPwModal({ id: u.id, username: u.username })}>
            Reset password
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void openIdentities(u)}>
            Linked OIDC identities
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setDeleteUser(u)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <span className="text-sm text-muted-foreground">View only</span>
    );

  const adminPanel = (
    <div className="flex flex-col gap-6">
      <details className="rounded-xl bg-card px-5 py-4">
        <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          What each role can do
        </summary>
        <div className="flex flex-col gap-3 pt-4">
          {ROLE_OPTIONS.map((r) => (
            <div key={r.value} className="rounded-lg bg-muted/50 px-3.5 py-3">
              <div className="text-sm font-semibold">{r.label}</div>
              <div className="mt-0.5 text-sm text-muted-foreground">{r.description}</div>
            </div>
          ))}
        </div>
      </details>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-heading text-xl font-semibold tracking-tight">All users</h2>
          <p className="text-sm text-muted-foreground">
            Create users, assign roles, reset passwords, and manage OIDC links.
          </p>
        </div>
        {headerActions}
      </div>

      {isNarrow ? (
        loading && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading users…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((u) => (
              <div key={u.id} className="flex flex-col gap-3 rounded-xl bg-card px-5 py-4">
                <div className="flex items-center gap-3">
                  <DashboardUserAvatar
                    username={u.username}
                    displayName={u.display_name}
                    displayIcon={u.display_icon}
                    size={40}
                  />
                  <div className="min-w-0">
                    <div className="truncate font-heading text-base font-medium">
                      {u.display_name?.trim() || u.username}
                    </div>
                    <div className="text-sm text-muted-foreground">@{u.username}</div>
                    <RoleText role={u.role} />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Created {new Date(u.created_at).toLocaleString()}
                </p>
                <div>{manageMenu(u)}</div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="rounded-xl bg-card px-2 py-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-13 px-3"><span className="sr-only">Avatar</span></TableHead>
                <TableHead className="px-3">Name</TableHead>
                <TableHead className="px-3">Username</TableHead>
                <TableHead className="px-3">Role</TableHead>
                <TableHead className="px-3">Created</TableHead>
                <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2"><Spinner /> Loading users</span>
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No users.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="px-3 py-3.5">
                      <DashboardUserAvatar
                        username={u.username}
                        displayName={u.display_name}
                        displayIcon={u.display_icon}
                        size={32}
                      />
                    </TableCell>
                    <TableCell className="px-3 py-3.5">{u.display_name?.trim() || "—"}</TableCell>
                    <TableCell className="px-3 py-3.5">{u.username}</TableCell>
                    <TableCell className="px-3 py-3.5"><RoleText role={u.role} /></TableCell>
                    <TableCell className="px-3 py-3.5">{new Date(u.created_at).toLocaleString()}</TableCell>
                    <TableCell className="px-3 py-3.5">{manageMenu(u)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {actionError ? (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        {canManage ? (
          <Tabs value={accountTab} onValueChange={(value) => setAccountTab(value as "profile" | "admin")}>
            <TabsList aria-label="Account sections">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="admin">Administration</TabsTrigger>
            </TabsList>
            <TabsContent value="profile">{profileCard}</TabsContent>
            <TabsContent value="admin">{adminPanel}</TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-col gap-6">
            {profileCard}
            <Alert>
              <AlertTitle>Administration</AlertTitle>
              <AlertDescription>
                Only administrators can open the user directory, create accounts, or change roles. Ask an admin if you need a
                new account or role change.
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>

      <CreateUserModal
        visible={createOpen}
        onDismiss={() => setCreateOpen(false)}
        isNarrow={isNarrow}
        onCreate={handleCreateUser}
      />

      <EditUserModal
        user={editOther}
        onDismiss={() => setEditOther(null)}
        isNarrow={isNarrow}
        onSave={saveOtherProfile}
      />

      <ResetPasswordModal
        visible={Boolean(pwModal)}
        onDismiss={() => setPwModal(null)}
        username={pwModal?.username ?? ""}
        onConfirm={handleResetPassword}
      />

      <OidcIdentitiesModal
        visible={Boolean(idModal)}
        onDismiss={() => setIdModal(null)}
        username={idModal?.username ?? ""}
        isNarrow={isNarrow}
        identities={identities}
        onLink={handleLinkIdentity}
        onUnlink={handleUnlinkIdentity}
      />

      <AlertDialog open={deleteUser !== null} onOpenChange={(open) => !open && !deleting && setDeleteUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteUser?.username ?? "this user"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the account. The user will no longer be able to sign in.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting && <Spinner />} Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
