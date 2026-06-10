import { SpaceBetween, ColumnLayout, FormField, Input, Select, Modal, Box, Button } from "../ui/console";
import type { DashboardRole } from "../../lib/types";

const ROLE_OPTIONS: { label: string; value: DashboardRole; description: string }[] = [
  {
    label: "Viewer",
    value: "viewer",
    description: "Read agents, telemetry, activity, and audit log. Cannot use live screen, remote actions, or scripts.",
  },
  {
    label: "Operator",
    value: "operator",
    description:
      "Everything viewers can do, plus live screen, wake/clear history, software inventory refresh, agent icon, and remote scripts (when enabled on the server).",
  },
  {
    label: "Admin",
    value: "admin",
    description:
      "Full control: retention, auto-update policy, local UI passwords, users, agent groups, and alert rules.",
  },
];

export interface CreateUserModalProps {
  visible: boolean;
  onDismiss: () => void;
  isNarrow: boolean;
  onCreate: (data: {
    display_name: string;
    username: string;
    password: string;
    role: DashboardRole;
  }) => Promise<void>;
}

import { useState } from "react";

export function CreateUserModal({
  visible,
  onDismiss,
  isNarrow,
  onCreate,
}: CreateUserModalProps) {
  const [create, setCreate] = useState<{
    display_name: string;
    username: string;
    password: string;
    role: DashboardRole;
  }>({
    display_name: "",
    username: "",
    password: "",
    role: "viewer",
  });
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      await onCreate(create);
      setCreate({ display_name: "", username: "", password: "", role: "viewer" });
      onDismiss();
    } catch {
      // Errors should be handled by the parent callback via rejection
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Create user"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={loading}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!create.username.trim() || create.password.length < 6}
              loading={loading}
              onClick={handleCreate}
            >
              Create
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label="Full name" description="Optional. Shown in the UI; sign-in still uses username.">
          <Input
            value={create.display_name}
            onChange={({ detail }) => setCreate((p) => ({ ...p, display_name: detail.value }))}
            placeholder="e.g. Jane Doe"
            disabled={loading}
          />
        </FormField>
        <ColumnLayout columns={isNarrow ? 1 : 2}>
          <FormField label="Username">
            <Input
              value={create.username}
              onChange={({ detail }) => setCreate((p) => ({ ...p, username: detail.value }))}
              disabled={loading}
            />
          </FormField>
          <FormField
            label="Role"
            description={ROLE_OPTIONS.find((o) => o.value === create.role)?.description ?? ""}
          >
            <Select
              selectedOption={{
                label: ROLE_OPTIONS.find((o) => o.value === create.role)?.label ?? create.role,
                value: create.role,
              }}
              onChange={({ detail }) => {
                const v = detail.selectedOption.value as DashboardRole | undefined;
                if (v) setCreate((p) => ({ ...p, role: v }));
              }}
              options={ROLE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              disabled={loading}
            />
          </FormField>
        </ColumnLayout>
        <FormField
          label="Temporary password"
          description="Min 6 characters. User can change later (reset again if needed)."
        >
          <Input
            type="password"
            value={create.password}
            onChange={({ detail }) => setCreate((p) => ({ ...p, password: detail.value }))}
            disabled={loading}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
