import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import type { DashboardRole } from "@/api/types";
import { authKeys } from "./auth";

/** Dashboard user accounts (admin directory). The signed-in user's own record is `authKeys.me()`. */
export const userKeys = {
  all: ["users"] as const,
  list: () => [...userKeys.all, "list"] as const,
  /** OIDC identities linked to one user. */
  identities: (userId: string) => [...userKeys.all, "identities", userId] as const,
};

export const userQueries = {
  list: () =>
    queryOptions({
      queryKey: userKeys.list(),
      queryFn: () => api.usersList(),
    }),
  identities: (userId: string) =>
    queryOptions({
      queryKey: userKeys.identities(userId),
      queryFn: () => api.userIdentities(userId),
    }),
};

/** Reload the signed-in user and the directory, as every account change on the Users page does. */
export function useReloadAccounts() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: authKeys.me() }),
      queryClient.invalidateQueries({ queryKey: userKeys.list() }),
    ]);
}

export type UserProfileBody = { username?: string; display_name?: string; display_icon?: string | null };

export function useSetUserRoleMutation() {
  const reload = useReloadAccounts();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: DashboardRole }) => api.userSetRole(id, role),
    onSuccess: () => reload(),
  });
}

/** `onDeleted` runs as soon as the server accepts, before the reload that keeps the mutation pending. */
export function useDeleteUserMutation(options?: { onDeleted?: () => void }) {
  const reload = useReloadAccounts();
  return useMutation({
    mutationFn: (id: string) => api.userDelete(id),
    onSuccess: () => {
      options?.onDeleted?.();
      return reload();
    },
  });
}

/** Stays pending until the accounts have reloaded; `onUpdated` runs first. */
export function useUpdateUserProfileMutation(options?: { onUpdated?: () => void }) {
  const reload = useReloadAccounts();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserProfileBody }) => api.userUpdateProfile(id, body),
    onSuccess: () => {
      options?.onUpdated?.();
      return reload();
    },
  });
}

export function useCreateUserMutation() {
  const reload = useReloadAccounts();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.userCreate>[0]) => api.userCreate(body),
    onSuccess: () => reload(),
  });
}

export function useSetUserPasswordMutation() {
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => api.userSetPassword(id, password),
  });
}

export function useLinkIdentityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, identity }: { userId: string; identity: { issuer: string; subject: string } }) =>
      api.userIdentityLink(userId, identity),
    onSuccess: (_data, { userId }) => queryClient.invalidateQueries({ queryKey: userKeys.identities(userId) }),
  });
}

export function useUnlinkIdentityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ identityId }: { identityId: number; userId: string | null }) => api.identityUnlink(identityId),
    onSuccess: (_data, { userId }) =>
      userId ? queryClient.invalidateQueries({ queryKey: userKeys.identities(userId) }) : undefined,
  });
}
