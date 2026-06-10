import { useState, useEffect } from "react";
import { Modal, SpaceBetween, FormField, Input, Box, Button } from "../ui/console";
import type { AgentGroup } from "../../lib/types";

export interface GroupModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null; // null for create
  onSave: (data: { name: string; description: string }) => Promise<void>;
}

export function GroupModal({
  visible,
  onDismiss,
  group,
  onSave,
}: GroupModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(group?.name ?? "");
      setDescription(group?.description ?? "");
    }
  }, [visible, group]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
      });
      onDismiss();
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
      header={group ? "Rename agent group" : "Create agent group"}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} loading={loading} disabled={!name.trim()}>
              Save
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label="Name">
          <Input value={name} onChange={({ detail }) => setName(detail.value)} disabled={loading} />
        </FormField>
        <FormField label="Description">
          <Input
            value={description}
            onChange={({ detail }) => setDescription(detail.value)}
            disabled={loading}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
