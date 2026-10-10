import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { DashboardUser } from "@/api/types";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { ROLE_TEXT } from "./roles";
import { UserAvatarFields } from "./UserAvatarFields";
import { profileValuesFor, type ProfileValues } from "./userProfile";
import { profileSchema } from "./userSchemas";

interface EditUserModalProps {
  user: DashboardUser | null;
  onDismiss: () => void;
  isNarrow: boolean;
  onSave: (data: ProfileValues) => Promise<void>;
}

export function EditUserModal({ user, onDismiss, isNarrow, onSave }: EditUserModalProps) {
  // The dialog can't be dismissed while the save request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{user ? `Profile: ${user.username}` : "Edit user"}</DialogTitle>
        </DialogHeader>
        {user ? <EditUserForm user={user} onDismiss={onDismiss} isNarrow={isNarrow} onSave={onSave} onBusyChange={setBusy} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditUserForm({ user, onDismiss, isNarrow, onSave, onBusyChange }: Omit<EditUserModalProps, "user"> & { user: DashboardUser; onBusyChange: (busy: boolean) => void }) {
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    mode: "onChange",
    defaultValues: profileValuesFor(user),
  });
  const { isValid, isSubmitting } = form.formState;
  const values = useWatch({ control: form.control });

  const submit = form.handleSubmit(async (data) => {
    onBusyChange(true);
    try {
      await onSave(data);
      onDismiss();
    } catch {
      // The parent reports the failure.
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <DashboardUserAvatar
            username={values.username || user.username}
            displayName={values.display_name ?? ""}
            displayIcon={values.display_icon || null}
            size={48}
          />
          <span className={`text-sm font-medium ${ROLE_TEXT[user.role]}`}>{user.role}</span>
        </div>
        <UserAvatarFields
          control={form.control}
          idLabel="Must be unique on this server."
          isNarrow={isNarrow}
          onImportError={() => {}} // Error notification handled by parent
          hideErrors
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
