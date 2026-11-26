import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { InputField } from "@/components/common/form/fields";
import { DialogError } from "./UserDialogParts";
import { messageOr } from "./messageOr";
import { resetPasswordSchema, type ResetPasswordValues } from "./userSchemas";

interface ResetPasswordModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Where focus goes when the dialog closes. */
  finalFocus?: () => HTMLElement | null;
  /** What the account is called (full name or username). */
  name: string;
  /** True when the admin is resetting their own password. */
  isSelf: boolean;
  /** Rejects with why the password could not be set; the dialog shows it and stays open. */
  onConfirm: (password: string) => Promise<void>;
}

export function ResetPasswordModal({
  visible,
  onDismiss,
  finalFocus,
  name,
  isSelf,
  onConfirm,
}: ResetPasswordModalProps) {
  // The dialog can't be dismissed while the request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent
        finalFocus={finalFocus}
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="break-words">Reset password for {name}</DialogTitle>
          <DialogDescription>
            {isSelf
              ? "You will be signed out right away."
              : `${name} will be signed out everywhere.`}{" "}
            The new password works from the next sign-in.
          </DialogDescription>
        </DialogHeader>
        {visible && (
          <ResetPasswordForm onDismiss={onDismiss} onConfirm={onConfirm} onBusyChange={setBusy} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordForm({
  onDismiss,
  onConfirm,
  onBusyChange,
}: Pick<ResetPasswordModalProps, "onDismiss" | "onConfirm"> & {
  onBusyChange: (busy: boolean) => void;
}) {
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: "onChange",
    defaultValues: { password: "" },
  });
  const { isValid, isSubmitting } = form.formState;
  const [error, setError] = useState<string | null>(null);

  const submit = form.handleSubmit(async ({ password }) => {
    onBusyChange(true);
    setError(null);
    try {
      await onConfirm(password);
      onDismiss();
    } catch (e: unknown) {
      setError(messageOr(e, "Failed to set password"));
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <InputField
        control={form.control}
        name="password"
        id="reset-password"
        label="New password"
        type="password"
        disabled={isSubmitting}
        autoComplete="new-password"
        className="h-9"
        placeholder="At least 6 characters"
        hideError
      />
      <DialogError prefix="Couldn't set the password" message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Set password
        </Button>
      </DialogFooter>
    </form>
  );
}
