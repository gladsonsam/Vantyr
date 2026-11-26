import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { useSession } from "@/app/providers/useSession";
import { messageOr } from "./messageOr";
import { profileChanges, type ProfileValues } from "./userProfile";
import type { CreateUserValues, LinkIdentityValues } from "./userSchemas";

type Target = { id: string; username: string; name: string };

/** Account queries and mutation ownership, separate from page composition. */
export function useUserManagement() {
  const { refresh: refreshSession } = useSession();
  const reloadAccounts = useReloadAccounts();

  const meQuery = useQuery(authQueries.me());
  const me = meQuery.data ?? null;
  const canManage = me?.role === "admin";
  const usersQuery = useQuery({ ...userQueries.list(), enabled: canManage });
  // A failed refresh keeps the last list that loaded; the page says so instead of showing an empty directory.
  const users = usersQuery.data?.users;

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<null | DashboardUser>(null);
  const [passwordTarget, setPasswordTarget] = useState<null | Target>(null);
  const [identityTarget, setIdentityTarget] = useState<null | Target>(null);
  const [deleteTarget, setDeleteTarget] = useState<null | DashboardUser>(null);
  const [roleTarget, setRoleTarget] = useState<null | { user: DashboardUser; role: DashboardRole }>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  // A dialog opened from a menu item hands focus back to that row's Manage button (or Create user when the row is gone).
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = (el: HTMLElement | null) => {
    opener.current = el;
  };
  const finalFocus = () =>
    opener.current?.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>("[data-create-user]");

  const identitiesQuery = useQuery({
    ...userQueries.identities(identityTarget?.id ?? ""),
    enabled: identityTarget !== null,
  });

  const setRoleMutation = useSetUserRoleMutation();
  const deleteMutation = useDeleteUserMutation({ onDeleted: () => setDeleteTarget(null) });
  const updateSelf = useUpdateUserProfileMutation();
  const updateOther = useUpdateUserProfileMutation({ onUpdated: () => setEditTarget(null) });
  const createUser = useCreateUserMutation();
  const setPassword = useSetUserPasswordMutation();
  const linkIdentity = useLinkIdentityMutation();
  const unlinkIdentity = useUnlinkIdentityMutation();

  const askRole = (user: DashboardUser, role: DashboardRole) => {
    setRoleError(null);
    setRoleTarget({ user, role });
  };
  const confirmRole = async () => {
    if (!roleTarget || !canManage) return;
    setRoleError(null);
    try {
      await setRoleMutation.mutateAsync({ id: roleTarget.user.id, role: roleTarget.role });
      setRoleTarget(null);
    } catch (e: unknown) {
      setRoleError(messageOr(e, "Failed to update role"));
    }
  };

  const askDelete = (user: DashboardUser) => {
    setDeleteError(null);
    setDeleteTarget(user);
  };
  const confirmDelete = async () => {
    if (!deleteTarget || !canManage) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
    } catch (e: unknown) {
      setDeleteError(messageOr(e, "Failed to delete user"));
    }
  };

  /** Each save below rejects with the server's reason; the dialog or card that asked reports it. */
  const saveSelfProfile = async (values: ProfileValues) => {
    if (!me) return;
    const body = profileChanges(me, values);
    if (Object.keys(body).length === 0) return;
    await updateSelf.mutateAsync({ id: me.id, body });
    void refreshSession();
  };

  const saveOtherProfile = async (values: ProfileValues) => {
    if (!editTarget) return;
    const body = profileChanges(editTarget, values);
    if (Object.keys(body).length === 0) {
      setEditTarget(null);
      return;
    }
    await updateOther.mutateAsync({ id: editTarget.id, body });
    void refreshSession();
  };

  const createAccount = async (data: CreateUserValues) => {
    await createUser.mutateAsync({
      username: data.username.trim(),
      password: data.password,
      role: data.role,
      ...(data.display_name.trim() ? { display_name: data.display_name.trim() } : {}),
    });
  };

  const resetPassword = async (password: string) => {
    if (!passwordTarget) return;
    await setPassword.mutateAsync({ id: passwordTarget.id, password });
  };

  const linkAccountIdentity = async (identity: LinkIdentityValues) => {
    if (!identityTarget) return;
    await linkIdentity.mutateAsync({
      userId: identityTarget.id,
      identity: { issuer: identity.issuer.trim(), subject: identity.subject.trim() },
    });
  };

  const unlinkAccountIdentity = async (identityId: number) => {
    await unlinkIdentity.mutateAsync({ identityId, userId: identityTarget?.id ?? null });
  };

  return {
    me,
    meLoading: meQuery.isPending,
    meError: meQuery.isError ? messageOr(meQuery.error, "Failed to load your account") : null,
    canManage,
    users,
    usersFetching: usersQuery.isFetching || meQuery.isFetching,
    usersError: usersQuery.isError ? messageOr(usersQuery.error, "Failed to load") : null,
    reloadAccounts,
    finalFocus,
    rememberOpener,
    createOpen,
    setCreateOpen,
    editTarget,
    setEditTarget,
    passwordTarget,
    setPasswordTarget,
    identityTarget,
    setIdentityTarget,
    identities: identitiesQuery.data?.identities ?? null,
    identitiesError: identitiesQuery.isError
      ? messageOr(identitiesQuery.error, "Failed to load")
      : null,
    identitiesFetching: identitiesQuery.isFetching,
    reloadIdentities: () => void identitiesQuery.refetch(),
    deleteTarget,
    setDeleteTarget,
    deleting: deleteMutation.isPending,
    deleteError,
    askDelete,
    confirmDelete,
    roleTarget,
    setRoleTarget,
    changingRole: setRoleMutation.isPending,
    roleError,
    askRole,
    confirmRole,
    saveSelfProfile,
    saveOtherProfile,
    createAccount,
    resetPassword,
    linkAccountIdentity,
    unlinkAccountIdentity,
  };
}

export type UserManagement = ReturnType<typeof useUserManagement>;
export type { Target };
