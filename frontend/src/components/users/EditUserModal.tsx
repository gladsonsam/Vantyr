import { useState } from "react";
import { SpaceBetween, Modal, Box, Button } from "../ui/console";
import { DashboardUserAvatar } from "../common/DashboardUserAvatar";
import { UserAvatarFields } from "./UserAvatarFields";
import type { DashboardUser, DashboardRole } from "../../lib/types";
import { Badge } from "../ui/console";

export interface EditUserModalProps {
  user: DashboardUser | null;
  onDismiss: () => void;
  isNarrow: boolean;
  onSave: (data: {
    display_name: string;
    username: string;
    display_icon: string;
  }) => Promise<void>;
}

export function EditUserModal({
  user,
  onDismiss,
  isNarrow,
  onSave,
}: EditUserModalProps) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [icon, setIcon] = useState("");
  const [saving, setSaving] = useState(false);

  const [prevUser, setPrevUser] = useState<DashboardUser | null>(null);

  if (user !== prevUser) {
    setPrevUser(user);
    if (user) {
      setDisplayName(user.display_name?.trim() ?? "");
      setUsername(user.username);
      setIcon(user.display_icon?.trim() ?? "");
    }
  }

  const handleSave = async () => {
    if (!username.trim()) return;
    setSaving(true);
    try {
      await onSave({
        display_name: displayName,
        username,
        display_icon: icon,
      });
      onDismiss();
    } catch {
      // Handled by parent
    } finally {
      setSaving(false);
    }
  };

  const roleBadge = (role: DashboardRole) => {
    const color = role === "admin" ? "red" : role === "operator" ? "blue" : "grey";
    return <Badge color={color}>{role}</Badge>;
  };

  return (
    <Modal
      visible={Boolean(user)}
      onDismiss={onDismiss}
      header={user ? `Profile: ${user.username}` : "Edit user"}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving} disabled={!username.trim()}>
              Save
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {user ? (
        <SpaceBetween size="l">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <DashboardUserAvatar
              username={username || user.username}
              displayName={displayName}
              displayIcon={icon || null}
              size={48}
            />
            {roleBadge(user.role)}
          </div>
          <UserAvatarFields
            fullName={displayName}
            setFullName={setDisplayName}
            username={username}
            setUsername={setUsername}
            icon={icon}
            setIcon={setIcon}
            idLabel="Must be unique on this server."
            isNarrow={isNarrow}
            onImportError={() => {}} // Error notification handled by parent
          />
        </SpaceBetween>
      ) : null}
    </Modal>
  );
}
