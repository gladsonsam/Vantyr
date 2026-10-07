import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

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
