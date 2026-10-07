import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

/** Everything group-related sits under `groupKeys.all`; invalidate it after any group or membership change. */
export const groupKeys = {
  all: ["agent-groups"] as const,
  list: () => [...groupKeys.all, "list"] as const,
  /** Groups one agent belongs to. */
  forAgent: (agentId: string) => [...groupKeys.all, "for-agent", agentId] as const,
  /** Agent ids in one group. */
  members: (groupId: string) => [...groupKeys.all, "members", groupId] as const,
};

export const groupQueries = {
  list: () =>
    queryOptions({
      queryKey: groupKeys.list(),
      queryFn: () => api.agentGroupsList(),
    }),
  forAgent: (agentId: string) =>
    queryOptions({
      queryKey: groupKeys.forAgent(agentId),
      queryFn: () => api.agentGroupsForAgent(agentId),
    }),
  members: (groupId: string) =>
    queryOptions({
      queryKey: groupKeys.members(groupId),
      queryFn: () => api.agentGroupMembers(groupId),
    }),
};
