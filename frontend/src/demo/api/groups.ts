import type { ApiClient } from "@/api";
import { demoAgents, demoGroups } from "@/demo/data";
import { asRecord, asStringArray } from "./helpers";

/** Fake agent groups endpoints. */
export function demoGroupsApi(): Partial<ApiClient> {
  return {
    agentGroupsForAgent: async () => ({ groups: demoGroups.slice(0, 2) }),
    agentGroupsList: async () => ({ groups: demoGroups }),
    agentGroupsCreate: async () => ({ id: "grp-demo-new" }),
    agentGroupsUpdate: async () => ({ ok: true }),
    agentGroupsDelete: async () => ({ ok: true }),
    agentGroupMembers: async () => ({ agent_ids: demoAgents.slice(0, 3).map((a) => a.id) }),
    agentGroupMembersAdd: async (body) => ({ added: asStringArray(asRecord(body).agent_ids).length }),
    agentGroupMemberRemove: async () => ({ ok: true }),
  };
}
