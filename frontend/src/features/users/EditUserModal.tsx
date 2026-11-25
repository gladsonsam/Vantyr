import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { DashboardUser } from "@/api/types";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { ROLE_ICON, ROLE_TEXT } from "./roles";
import { UserAvatarFields } from "./UserAvatarFields";
import { DialogError } from "./UserDialogParts";
import { messageOr } from "./messageOr";
import { userLabel } from "./userDirectory";
import { profileValuesFor, type ProfileValues } from "./userProfile";
import { profileSchema } from "./userSchemas";

interface EditUserModalProps {
  user: DashboardUser | null;
  /** True when the admin is editing their own account. */
  isSelf: boolean;
  onDismiss: () => void;
  /** Where focus goes when the dialog closes. */
  finalFocus?: () => HTMLElement | null;
  /** Rejects with why the profile could not be saved; the dialog shows it and stays open. */
  onSave: (data: ProfileValues) => Promise<void>;
}

export function EditUserModal({ user, isSelf, onDismiss, finalFocus, onSave }: EditUserModalProps) {
  // The dialog can't be dismissed while the save request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">{user ? `Edit ${userLabel(user)}` : "Edit user"}</DialogTitle>
          <DialogDescription>Name, username and avatar. Changing the username changes how they sign in.</DialogDescription>
        </DialogHeader>
        {user ? <EditUserForm key={user.id} user={user} isSelf={isSelf} onDismiss={onDismiss} onSave={onSave} onBusyChange={setBusy} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditUserForm({ user, isSelf, onDismiss, onSave, onBusyChange }: Omit<EditUserModalProps, "user"> & { user: DashboardUser; onBusyChange: (busy: boolean) => void }) {
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    mode: "onChange",
    defaultValues: profileValuesFor(user),
  });
  const { isValid, isSubmitting } = form.formState;
  const values = useWatch({ control: form.control });
  const [error, setError] = useState<string | null>(null);
  const RoleIcon = ROLE_ICON[user.role];

  const submit = form.handleSubmit(async (data) => {
    onBusyChange(true);
    setError(null);
    try {
      await onSave(data);
      onDismiss();
    } catch (e: unknown) {
      setError(messageOr(e, "Failed to save user"));
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
          <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${ROLE_TEXT[user.role]}`}>
            <RoleIcon className="size-3.5" aria-hidden /> {user.role}
            {isSelf && <span className="font-normal text-muted-foreground">· You</span>}
          </span>
        </div>
        <UserAvatarFields
          control={form.control}
          usernameHint="Must be unique on this server."
          disabled={isSubmitting}
        />
        <DialogError prefix="Couldn't save" message={error} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
