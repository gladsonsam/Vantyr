import { useState, useMemo } from "react";
import { Modal, SpaceBetween, FormField, Select, Button, Header, Table, Box } from "../ui/console";
import type { Agent, AgentGroup } from "../../lib/types";

export interface MembersModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null;
  memberIds: string[];
  agentsList: Agent[];
  agentOptions: { label: string; value: string }[];
  isNarrow: boolean;
  onAddMembers: (agentIds: string[]) => Promise<void>;
  onRemoveMember: (agentId: string) => Promise<void>;
}

type AddableMemberRow = { agentId: string; label: string };

export function MembersModal({
  visible,
  onDismiss,
  group,
  memberIds,
  agentsList,
  agentOptions,
  isNarrow,
  onAddMembers,
  onRemoveMember,
}: MembersModalProps) {
  const [addAgentId, setAddAgentId] = useState("");
  const [membersAddSelection, setMembersAddSelection] = useState<AddableMemberRow[]>([]);
  const [loading, setLoading] = useState(false);

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agentsList) m[a.id] = a;
    return m;
  }, [agentsList]);

  const addableAgents = useMemo(() => {
    const set = new Set(memberIds);
    return agentOptions.filter((o) => !set.has(o.value));
  }, [memberIds, agentOptions]);

  const addableMemberRows = useMemo(() => {
    const set = new Set(memberIds);
    return agentOptions
      .filter((o) => !set.has(o.value))
      .map((o) => ({ agentId: o.value, label: o.label }));
  }, [memberIds, agentOptions]);

  const handleAddSingle = async () => {
    if (!addAgentId) return;
    setLoading(true);
    try {
      await onAddMembers([addAgentId]);
      setAddAgentId("");
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  const handleAddMultiple = async () => {
    if (membersAddSelection.length === 0) return;
    setLoading(true);
    try {
      await onAddMembers(membersAddSelection.map((r) => r.agentId));
      setMembersAddSelection([]);
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (agentId: string) => {
    setLoading(true);
    try {
      await onRemoveMember(agentId);
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={group ? `Members: ${group.name}` : "Members"}
      size="large"
      footer={
        <Box float="right">
          <Button variant="link" onClick={onDismiss}>
            Close
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label="Add agent">
          <div className="vantyr-notify-members-add">
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={
                  addAgentId ? addableAgents.find((o) => o.value === addAgentId) ?? null : null
                }
                onChange={({ detail }) => {
                  const v = detail.selectedOption?.value;
                  setAddAgentId(typeof v === "string" ? v : "");
                }}
                options={addableAgents}
                placeholder="Choose an agent"
                filteringType="auto"
                empty="No agents available to add"
                disabled={loading}
              />
              <Button disabled={!addAgentId || loading} onClick={handleAddSingle}>
                Add
              </Button>
            </SpaceBetween>
          </div>
        </FormField>
        {addableMemberRows.length > 0 && (
          <SpaceBetween size="s">
            <Header variant="h3">Add several agents</Header>
            <Table
              trackBy="agentId"
              variant="embedded"
              selectionType="multi"
              selectedItems={membersAddSelection}
              onSelectionChange={({ detail }) =>
                setMembersAddSelection((detail.selectedItems ?? []) as AddableMemberRow[])
              }
              columnDefinitions={[
                {
                  id: "agent",
                  header: "Agent",
                  cell: (r: AddableMemberRow) => r.label,
                },
              ]}
              items={addableMemberRows}
            />
            <Button
              disabled={membersAddSelection.length === 0 || loading}
              onClick={handleAddMultiple}
            >
              Add selected ({membersAddSelection.length})
            </Button>
          </SpaceBetween>
        )}
        {isNarrow ? (
          memberIds.length === 0 ? (
            <Box color="text-body-secondary">No members in this group.</Box>
          ) : (
            <SpaceBetween size="m">
              {memberIds.map((id) => (
                <Box key={id} variant="div" className="vantyr-users-mobile-card">
                  <SpaceBetween size="s">
                    <Box fontSize="heading-s" fontWeight="bold">
                      {agentsById[id]?.name ?? id}
                    </Box>
                    <Button disabled={loading} onClick={() => handleRemove(id)}>
                      Remove from group
                    </Button>
                  </SpaceBetween>
                </Box>
              ))}
            </SpaceBetween>
          )
        ) : (
          <Table
            columnDefinitions={[
              {
                id: "name",
                header: "Agent",
                cell: (id: string) => agentsById[id]?.name ?? id,
              },
              {
                id: "rm",
                header: "",
                cell: (id: string) => (
                  <Button variant="link" disabled={loading} onClick={() => handleRemove(id)}>
                    Remove
                  </Button>
                ),
              },
            ]}
            items={memberIds}
            empty={<Box color="text-body-secondary">No members in this group.</Box>}
            variant="embedded"
          />
        )}
      </SpaceBetween>
    </Modal>
  );
}
