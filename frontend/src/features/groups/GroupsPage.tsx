import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import type { AgentGroup } from "@/api/types";

import { PageActions } from "@/app/shell/AppShell";
import { RefreshButton } from "@/components/common/RefreshButton";
import { DeleteGroupDialog } from "./DeleteGroupDialog";
import type { GroupAction } from "./GroupList";
import { GroupsContent } from "./GroupsContent";
import { GroupModal } from "./GroupModal";
import { GroupMembersDialog } from "./GroupMembersDialog";
import { PageNotice } from "./PageNotice";
import { GroupRuleDialog } from "./GroupRuleDialog";
import { messageOf } from "./groupSummary";
import { useGroupsData } from "./useGroupsData";
import { useGroupMutations } from "./useGroupMutations";

export function GroupsPage() {
  const data = useGroupsData();
  const { groups, agents } = data;
  // Failures of the new-rule save; everything else reports inside the card or dialog it belongs to.
  const [ruleError, setRuleError] = useState<string | null>(null);

  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<AgentGroup | null>(null);

  // The members dialog is open while a group is chosen.
  const [membersGroup, setMembersGroup] = useState<AgentGroup | null>(null);

  // New alert rule for a group
  const [ruleGroup, setRuleGroup] = useState<AgentGroup | null>(null);

  const [deleteGroup, setDeleteGroup] = useState<AgentGroup | null>(null);

  const { saveGroup, addMembers, removeMember, removeGroup } = useGroupMutations((groupId) => {
    setDeleteGroup(null);
    setMembersGroup((open) => (open?.id === groupId ? null : open));
  });

  const openCreateGroup = () => {
    setActiveGroup(null);
    setGroupModalOpen(true);
  };

  const handleSaveGroup = async (data: { name: string; description: string }) => {
    await saveGroup.mutateAsync({ id: activeGroup?.id ?? null, data });
  };

  const handleAddMembers = async (agentIds: string[]) => {
    if (!membersGroup) return;
    await addMembers.mutateAsync({ groupId: membersGroup.id, agentIds });
  };

  const handleRemoveMember = async (agentId: string) => {
    if (!membersGroup) return;
    await removeMember.mutateAsync({ groupId: membersGroup.id, agentId });
  };

  const onGroupAction = (g: AgentGroup, action: GroupAction) => {
    if (action === "members") setMembersGroup(g);
    else if (action === "rule") setRuleGroup(g);
    else if (action === "rename") {
      setActiveGroup(g);
      setGroupModalOpen(true);
    } else {
      removeGroup.reset();
      setDeleteGroup(g);
    }
  };

  const refresh = () => {
    setRuleError(null);
    data.refresh();
  };

  // The newest copy of the open group, so a rename shows without reopening.
  const openMembersGroup = membersGroup ? (groups.find((g) => g.id === membersGroup.id) ?? membersGroup) : null;
  const deleteRuleCount = deleteGroup && data.ruleCounts ? (data.ruleCounts.get(deleteGroup.id) ?? 0) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageActions>
        <RefreshButton onClick={refresh} loading={data.loading} />
        <Button onClick={openCreateGroup}>
          <Plus /> Create group
        </Button>
      </PageActions>

      {ruleError && <PageNotice message={ruleError} onDismiss={() => setRuleError(null)} />}
      {data.staleError && (
        <PageNotice message={`Couldn’t refresh groups: ${data.staleError}. The list may be out of date.`} onRetry={data.retryGroups} />
      )}
      {data.agentsError && (
        <PageNotice message={`Couldn’t load devices: ${data.agentsError}. Members may show as unknown.`} onRetry={data.retryAgents} />
      )}

      <GroupsContent
        groups={groups}
        loading={data.firstLoad}
        loadError={data.listError}
        onRetry={data.retryGroups}
        ruleCounts={data.ruleCounts}
        onCreate={openCreateGroup}
        onAction={onGroupAction}
      />

      <GroupModal
        visible={groupModalOpen}
        onDismiss={() => {
          setGroupModalOpen(false);
          setActiveGroup(null);
        }}
        group={activeGroup}
        onSave={handleSaveGroup}
      />

      <GroupMembersDialog
        group={openMembersGroup}
        agentsList={agents}
        onDismiss={() => setMembersGroup(null)}
        onAddMembers={handleAddMembers}
        onRemoveMember={handleRemoveMember}
      />

      <GroupRuleDialog
        group={ruleGroup}
        agentOptions={data.agentOptions}
        groupOptions={data.groupOptions}
        onDismiss={() => setRuleGroup(null)}
        onError={setRuleError}
      />

      <DeleteGroupDialog
        group={deleteGroup}
        ruleCount={deleteRuleCount}
        pending={removeGroup.isPending}
        error={removeGroup.isError ? messageOf(removeGroup.error) : null}
        onClose={() => setDeleteGroup(null)}
        onConfirm={() => deleteGroup && removeGroup.mutate(deleteGroup.id)}
      />
    </div>
  );
}
