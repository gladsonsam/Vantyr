import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { groupKeys } from "@/api/queries/groups";

/**
 * The page's writes. Each one invalidates the group queries (or the rule list) and resolves only after the
 * refetch, so a dialog that awaits it shows fresh member lists and counts.
 */
export function useGroupMutations(onGroupDeleted: (groupId: string) => void) {
  const queryClient = useQueryClient();
  const invalidateGroups = () => queryClient.invalidateQueries({ queryKey: groupKeys.all });

  const saveGroup = useMutation({
    mutationFn: async ({ id, data }: { id: string | null; data: { name: string; description: string } }) => {
      if (id) await api.agentGroupsUpdate(id, data);
      else await api.agentGroupsCreate(data);
    },
    onSuccess: () => invalidateGroups(),
  });

  const addMembers = useMutation({
    mutationFn: ({ groupId, agentIds }: { groupId: string; agentIds: string[] }) =>
      api.agentGroupMembersAdd(groupId, { agent_ids: agentIds }),
    onSuccess: () => invalidateGroups(),
  });

  const removeMember = useMutation({
    mutationFn: ({ groupId, agentId }: { groupId: string; agentId: string }) =>
      api.agentGroupMemberRemove(groupId, agentId),
    onSuccess: () => invalidateGroups(),
  });

  const removeGroup = useMutation({
    mutationFn: (groupId: string) => api.agentGroupsDelete(groupId),
    onSuccess: (_data, groupId) => {
      onGroupDeleted(groupId);
      queryClient.removeQueries({ queryKey: groupKeys.members(groupId) });
      return invalidateGroups();
    },
  });

  return { saveGroup, addMembers, removeMember, removeGroup };
}
