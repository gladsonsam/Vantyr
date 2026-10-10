import type { DashboardIdentity, DashboardRole, DashboardUser } from "@/api/types";
import { get, postEmpty, postJsonRes } from "@/api/client";

export const usersEndpoints = {
  // ── Admin: users / identities ─────────────────────────────────────────────

  usersList: (): Promise<{ users: DashboardUser[] }> => get("/users"),

  userCreate: (body: {
    username: string;
    password: string;
    role: DashboardRole;
    display_name?: string;
  }): Promise<{ id: string }> => postJsonRes("/users", body),

  userSetPassword: (id: string, password: string): Promise<{ ok: boolean }> =>
    postJsonRes(`/users/${id}/password`, { password }),

  userSetRole: (id: string, role: DashboardRole): Promise<{ ok: boolean }> =>
    postJsonRes(`/users/${id}/role`, { role }),

  userUpdateProfile: (
    id: string,
    body: { username?: string; display_name?: string; display_icon?: string | null },
  ): Promise<{
    ok: boolean;
    id: string;
    username: string;
    display_name: string;
    display_icon: string | null;
  }> => postJsonRes(`/users/${id}/profile`, body),

  userDelete: (id: string): Promise<{ ok: boolean }> =>
    postEmpty(`/users/${id}/delete`),

  userIdentities: (id: string): Promise<{ identities: DashboardIdentity[] }> =>
    get(`/users/${id}/identities`),

  userIdentityLink: (
    id: string,
    body: { issuer: string; subject: string },
  ): Promise<{ ok: boolean }> => postJsonRes(`/users/${id}/identities/link`, body),

  identityUnlink: (identityId: number): Promise<{ ok: boolean }> =>
    postEmpty(`/identities/${identityId}/unlink`),
};
