import type { AgentGroup, AgentGroupMembership } from "@/api/types";
import { get, putJson, postJsonRes, delJson } from "@/api/client";

export const groupsEndpoints = {
  /** Admin: groups this agent belongs to. */
  agentGroupsForAgent: (id: string): Promise<{ groups: AgentGroupMembership[] }> =>
    get(`/agents/${id}/groups`),

  // ── Admin: agent groups & alert rules (URL / keystroke notifications) ───────

  agentGroupsList: (): Promise<{ groups: AgentGroup[] }> => get("/agent-groups"),

  agentGroupsCreate: (body: {
    name: string;
    description?: string;
  }): Promise<{ id: string }> => postJsonRes("/agent-groups", body),

  agentGroupsUpdate: (
    id: string,
    body: { name: string; description?: string },
  ): Promise<{ ok: boolean }> => putJson(`/agent-groups/${id}`, body),

  agentGroupsDelete: (id: string): Promise<{ ok: boolean }> =>
    delJson(`/agent-groups/${id}`),

  agentGroupMembers: (groupId: string): Promise<{ agent_ids: string[] }> =>
    get(`/agent-groups/${groupId}/members`),

  agentGroupMembersAdd: (
    groupId: string,
    body: { agent_ids: string[] },
  ): Promise<{ added: number }> =>
    postJsonRes(`/agent-groups/${groupId}/members`, body),

  agentGroupMemberRemove: (
    groupId: string,
    agentId: string,
  ): Promise<{ ok: boolean }> =>
    delJson(`/agent-groups/${groupId}/members/${agentId}`),
};
