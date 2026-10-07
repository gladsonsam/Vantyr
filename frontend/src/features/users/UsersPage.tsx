import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authQueries } from "@/api/queries/auth";
import {
  useCreateUserMutation,
  useDeleteUserMutation,
  useLinkIdentityMutation,
  userQueries,
  useReloadAccounts,
  useSetUserPasswordMutation,
  useSetUserRoleMutation,
  useUnlinkIdentityMutation,
  useUpdateUserProfileMutation,
} from "@/api/queries/users";
import type { DashboardRole, DashboardUser } from "@/api/types";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSession } from "@/app/providers/useSession";
import { CreateUserModal } from "./CreateUserModal";
import { EditUserModal } from "./EditUserModal";
import { ResetPasswordModal } from "./ResetPasswordModal";
import { OidcIdentitiesModal } from "./OidcIdentitiesModal";
import { ROLE_OPTIONS } from "./roles";
import { profileChanges, type ProfileValues } from "./userProfile";
import { UserProfileCard } from "./UserProfileCard";
import { UsersTable } from "./UsersTable";

const NO_USERS: DashboardUser[] = [];

/** The page's error text: the error's message, else the given fallback. */
function messageOr(e: unknown, fallback: string): string {
  return String((e as { message?: string })?.message || fallback);
}

export function UsersPage() {
  // Refresh the session user after profile/username updates.
  const { refresh: refreshSession } = useSession();
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const meQuery = useQuery(authQueries.me());
  const me = meQuery.data ?? null;
  const canManage = me?.role === "admin";
  const usersQuery = useQuery({ ...userQueries.list(), enabled: canManage });
  const loading = meQuery.isFetching || usersQuery.isFetching;
  // A failed load empties the directory, as the combined loader did.
  const items =
    !canManage || meQuery.isError || usersQuery.isError ? NO_USERS : usersQuery.data?.users ?? NO_USERS;
  const loadFailure = loading ? null : meQuery.error ?? (canManage ? usersQuery.error : null);
  const error = loadFailure ? messageOr(loadFailure, "Failed to load") : null;
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);

  const [pwModal, setPwModal] = useState<null | { id: string; username: string }>(null);

  const [idModal, setIdModal] = useState<null | { id: string; username: string }>(null);
  const identitiesQuery = useQuery({ ...userQueries.identities(idModal?.id ?? ""), enabled: idModal !== null });
  const identities = identitiesQuery.data?.identities ?? null;
  const identitiesError =
    idModal && identitiesQuery.error ? messageOr(identitiesQuery.error, "Failed to load identities") : null;

  const [editOther, setEditOther] = useState<null | DashboardUser>(null);
  const [deleteUser, setDeleteUser] = useState<null | DashboardUser>(null);

  const [accountTab, setAccountTab] = useState<"profile" | "admin">("profile");

  const reloadAccounts = useReloadAccounts();

  const setRoleMutation = useSetUserRoleMutation();
  const deleteUserMutation = useDeleteUserMutation({ onDeleted: () => setDeleteUser(null) });
  const deleting = deleteUserMutation.isPending;
  const updateSelf = useUpdateUserProfileMutation();
  const savingSelf = updateSelf.isPending;
  const updateOther = useUpdateUserProfileMutation({ onUpdated: () => setEditOther(null) });
  const createUser = useCreateUserMutation();
  const setPassword = useSetUserPasswordMutation();
  const linkIdentity = useLinkIdentityMutation();
  const unlinkIdentity = useUnlinkIdentityMutation();

  const setRole = async (u: DashboardUser, role: DashboardRole) => {
    try {
      setActionError(null);
      await setRoleMutation.mutateAsync({ id: u.id, role });
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to update role"));
    }
  };

  const openIdentities = (u: DashboardUser) => {
    setActionError(null);
    setIdModal({ id: u.id, username: u.username });
  };

  const confirmDelete = async () => {
    if (!deleteUser || !canManage) return;
    try {
      setActionError(null);
      await deleteUserMutation.mutateAsync(deleteUser.id);
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to delete user"));
    }
  };

  const saveSelfProfile = async (values: ProfileValues) => {
    if (!me) return;
    setActionError(null);
    try {
      const body = profileChanges(me, values);
      if (Object.keys(body).length === 0) return;
      await updateSelf.mutateAsync({ id: me.id, body });
      void refreshSession();
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to save profile"));
    }
  };

  const saveOtherProfile = async (data: ProfileValues) => {
    if (!editOther) return;
    setActionError(null);
    try {
      const body = profileChanges(editOther, data);
      if (Object.keys(body).length === 0) {
        setEditOther(null);
        return;
      }
      await updateOther.mutateAsync({ id: editOther.id, body });
      void refreshSession();
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to save user"));
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
      await createUser.mutateAsync({
        username: data.username.trim(),
        password: data.password,
        role: data.role,
        ...(data.display_name.trim() ? { display_name: data.display_name.trim() } : {}),
      });
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to create user"));
      throw e;
    }
  };

  const handleResetPassword = async (password: string) => {
    if (!pwModal) return;
    try {
      setActionError(null);
      await setPassword.mutateAsync({ id: pwModal.id, password });
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to set password"));
      throw e;
    }
  };

  const handleLinkIdentity = async (identity: { issuer: string; subject: string }) => {
    if (!idModal) return;
    try {
      setActionError(null);
      await linkIdentity.mutateAsync({
        userId: idModal.id,
        identity: { issuer: identity.issuer.trim(), subject: identity.subject.trim() },
      });
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to link identity"));
      throw e;
    }
  };

  const handleUnlinkIdentity = async (identityId: number) => {
    try {
      setActionError(null);
      await unlinkIdentity.mutateAsync({ identityId, userId: idModal?.id ?? null });
    } catch (e: unknown) {
      setActionError(messageOr(e, "Failed to unlink identity"));
      throw e;
    }
  };

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void reloadAccounts()}>
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
    <UserProfileCard
      me={me}
      version={meQuery.dataUpdatedAt}
      isNarrow={isNarrow}
      saving={savingSelf}
      onSave={(values) => void saveSelfProfile(values)}
      onImportError={setActionError}
    />
  ) : null;

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

      <UsersTable
        items={items}
        loading={loading}
        isNarrow={isNarrow}
        canManage={canManage}
        onEdit={setEditOther}
        onSetRole={(u, role) => void setRole(u, role)}
        onResetPassword={(u) => setPwModal({ id: u.id, username: u.username })}
        onIdentities={openIdentities}
        onDelete={setDeleteUser}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {actionError ?? identitiesError ? (
          <Alert variant="destructive">
            <AlertDescription>{actionError ?? identitiesError}</AlertDescription>
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
