import { useQuery } from "@tanstack/react-query";
import { groupQueries } from "@/api/queries/groups";
import type { Agent, AgentGroup } from "@/api/types";
import { MembersModal } from "./MembersModal";
import { messageOf } from "./groupSummary";

interface GroupMembersDialogProps {
  /** The group whose members are shown; the dialog is closed while this is null. */
  group: AgentGroup | null;
  agentsList: Agent[];
  onDismiss: () => void;
  onAddMembers: (agentIds: string[]) => Promise<void>;
  onRemoveMember: (agentId: string) => Promise<void>;
}

/** Reads the open group's members fresh on every open and hands them to the dialog. */
export function GroupMembersDialog({ group, agentsList, onDismiss, onAddMembers, onRemoveMember }: GroupMembersDialogProps) {
  const members = useQuery({
    ...groupQueries.members(group?.id ?? ""),
    enabled: group !== null,
    staleTime: 0,
  });
  const failed = members.isError && !members.isFetching;
  return (
    <MembersModal
      visible={group !== null}
      onDismiss={onDismiss}
      group={group}
      memberIds={members.data?.agent_ids ?? null}
      loadError={failed ? `Couldn’t load members: ${messageOf(members.error)}` : null}
      onRetry={() => void members.refetch()}
      agentsList={agentsList}
      onAddMembers={onAddMembers}
      onRemoveMember={onRemoveMember}
    />
  );
}
