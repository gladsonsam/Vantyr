import type { ApiClient } from "@/api";
import { demoUsers } from "@/demo/data";
import { asRecord } from "./helpers";

/** Fake dashboard users and identities endpoints. */
export function demoUsersApi(): Partial<ApiClient> {
  return {
    usersList: async () => ({ users: demoUsers }),
    userCreate: async () => ({ id: "demo-user-new" }),
    userSetPassword: async () => ({ ok: true }),
    userSetRole: async () => ({ ok: true }),
    userUpdateProfile: async (_id, body) => ({ ok: true, id: String(_id), username: String(asRecord(body).username ?? "admin"), display_name: String(asRecord(body).display_name ?? "Demo Admin"), display_icon: asRecord(body).display_icon as string | null }),
    userDelete: async () => ({ ok: true }),
    userIdentities: async () => ({ identities: [] }),
    userIdentityLink: async () => ({ ok: true }),
    identityUnlink: async () => ({ ok: true }),
  };
}
