import { useEffect, useMemo, useState } from "react";
import { Modal, Box, Button, FormField, Select, SpaceBetween, Alert } from "../ui/console";
import { api } from "../../lib/api";
import type { AgentGroup } from "../../lib/types";

export function BulkAddToGroupModal({
  agentIds,
  onDismiss,
}: {
  agentIds: string[];
  onDismiss: () => void;
}) {
  const [groups, setGroups] = useState<AgentGroup[] | null>(null);
  const [groupId, setGroupId] = useState<string>("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    setLoadErr(null);
    api
      .agentGroupsList()
      .then((r) => {
        if (!c) setGroups(r.groups);
      })
      .catch((e) => {
        if (!c) setLoadErr(String(e));
      });
    return () => {
      c = true;
    };
  }, []);

  const options = useMemo(
    () => (groups ?? []).map((g) => ({ label: g.name, value: g.id })),
    [groups],
  );

  const submit = async () => {
    if (!groupId || agentIds.length === 0) return;
    setActionErr(null);
    setBusy(true);
    try {
      await api.agentGroupMembersAdd(groupId, { agent_ids: agentIds });
      onDismiss();
    } catch (e: unknown) {
      setActionErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header="Add selected agents to group"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!groupId || busy || agentIds.length === 0}
              loading={busy}
              onClick={() => void submit()}
            >
              Add to group
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {loadErr && (
          <Alert type="error" dismissible onDismiss={() => setLoadErr(null)}>
            {loadErr}
          </Alert>
        )}
        {actionErr && (
          <Alert type="error" dismissible onDismiss={() => setActionErr(null)}>
            {actionErr}
          </Alert>
        )}
        <Box color="text-body-secondary">
          {agentIds.length} agent{agentIds.length === 1 ? "" : "s"} will be added (existing memberships are kept).
        </Box>
        <FormField label="Group">
          <Select
            selectedOption={groupId ? options.find((o) => o.value === groupId) ?? null : null}
            onChange={({ detail }) => {
              const v = detail.selectedOption?.value;
              setGroupId(typeof v === "string" ? v : "");
            }}
            options={options}
            placeholder="Choose a group"
            disabled={groups === null || options.length === 0}
            empty="No groups yet — open Agent groups from the overview or the Groups page to create one."
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
