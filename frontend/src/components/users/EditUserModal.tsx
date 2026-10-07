import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { DashboardUserAvatar } from "@/components/common/DashboardUserAvatar";
import { UserAvatarFields } from "./UserAvatarFields";
import type { DashboardUser, DashboardRole } from "@/lib/types";

interface EditUserModalProps {
  user: DashboardUser | null;
  onDismiss: () => void;
  isNarrow: boolean;
  onSave: (data: {
    display_name: string;
    username: string;
    display_icon: string;
  }) => Promise<void>;
}

const ROLE_TEXT: Record<DashboardRole, string> = {
  admin: "text-warning",
  operator: "text-info",
  viewer: "text-muted-foreground",
};

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

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && !saving && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{user ? `Profile: ${user.username}` : "Edit user"}</DialogTitle>
        </DialogHeader>
        {user ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <DashboardUserAvatar
                username={username || user.username}
                displayName={displayName}
                displayIcon={icon || null}
                size={48}
              />
              <span className={`text-sm font-medium ${ROLE_TEXT[user.role]}`}>{user.role}</span>
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
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss} disabled={saving}>
            Cancel
          </Button>
          <Button disabled={!username.trim() || saving} onClick={() => void handleSave()}>
            {saving && <Spinner />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
